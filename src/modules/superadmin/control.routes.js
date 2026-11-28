import { sessionsToRevoke } from "../access/session-cap.js";
import { readControls, presentControls, saveControls } from "./settings.js";
import { exportData, previewImport, importData, backupHash } from "./data.js";
import { Router } from "express";
import { z } from "zod";
import { Op, QueryTypes } from "sequelize";
import {
  sequelize,
  AdminUser,
  AuthSession,
  Partner,
  PermissionRole,
  ImpersonationGrant,
  License,
  Plan,
  Activation,
  DeviceSession,
  ResellerClient,
  PlatformSetting,
} from "../../db/models/index.js";
import {
  requirePermission,
  PERMISSIONS,
  resolveAdminClaims,
} from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { pageQuery, pageOf, paged } from "../../shared/pagination.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import {
  generateCode,
  hashCode,
  signJwt,
  sha256,
  encryptSecret,
  decryptSecret,
} from "../../shared/crypto.js";
import { addLicenseMonthsUTC } from "../../shared/dates.js";
import { revokeAllSessions } from "../auth/auth.service.js";
import {
  disconnectAdminUser,
  disconnectAdminSession,
} from "../../realtime/socket.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import {
  adjustedExpiry,
  allowedRolePermissions,
  reportPeriod,
  csvCell,
} from "./policy.js";
const r = Router();
// A custom role can only narrow an existing role and can never acquire this guard.
r.use((req, _res, next) => {
  if (req.user?.role !== "superadmin" || req.impersonator)
    throw new AppError(403, "FORBIDDEN", "Área exclusiva do superadmin.");
  next();
});
r.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const id = z.object({ id: z.string().uuid() });
const reason = z.string().trim().min(5).max(500);
const sql = (text, replacements = {}, transaction) =>
  sequelize.query(text, { replacements, transaction, type: QueryTypes.SELECT });
const activePartner = async (id, transaction) => {
  if (id === null) return null;
  const p = await Partner.findByPk(id, { transaction });
  if (!p || p.status !== "active")
    throw new AppError(422, "INVALID_PARTNER", "Selecione uma parceria ativa.");
  return p;
};

r.get("/permissions", (_req, res) => res.json({ roles: PERMISSIONS }));
r.get("/roles", async (_req, res) =>
  res.json({
    data: await PermissionRole.findAll({ order: [["name", "ASC"]] }),
  }),
);
const roleBody = z
  .object({
    name: z.string().trim().min(2).max(80),
    baseRole: z.enum(["admin", "support", "partner"]),
    permissions: z.array(z.string().max(80)).max(100),
    reason,
  })
  .strict();
for (const method of ["post", "patch"])
  r[method](
    method === "post" ? "/roles" : "/roles/:id",
    validate({ ...(method === "patch" ? { params: id } : {}), body: roleBody }),
    async (req, res) => {
      const { reason, ...b } = req.valid.body;
      b.permissions = allowedRolePermissions(
        b.baseRole,
        b.permissions,
        PERMISSIONS,
      );
      const result = await sequelize.transaction(async (transaction) => {
        const row =
          method === "patch"
            ? await PermissionRole.findByPk(req.valid.params.id, {
                transaction,
                lock: transaction.LOCK.UPDATE,
              })
            : null;
        if (method === "patch" && !row) throw notFound("Papel");
        if (
          row &&
          row.baseRole !== b.baseRole &&
          (await AdminUser.count({
            where: { permissionRoleId: row.id },
            transaction,
          }))
        )
          throw new AppError(
            409,
            "ROLE_IN_USE",
            "Remova as atribuições antes de alterar a função base.",
          );
        const before = row?.toJSON() || null;
        const next = row
          ? await row.update(b, { transaction })
          : await PermissionRole.create(b, { transaction });
        const users = await AdminUser.findAll({
          where: { permissionRoleId: next.id },
          attributes: ["id"],
          transaction,
        });
        for (const u of users) await revokeAllSessions(u.id, transaction);
        transaction.afterCommit(() =>
          users.forEach((u) => disconnectAdminUser(u.id)),
        );
        await audit({
          actor: actorOf(req),
          action: "role.save",
          entityType: "permission_role",
          entityId: next.id,
          metadata: { reason, before, after: next.toJSON() },
          transaction,
        });
        return next;
      });
      res.status(method === "post" ? 201 : 200).json(result);
    },
  );
r.delete(
  "/roles/:id",
  validate({ params: id, body: z.object({ reason }).strict() }),
  async (req, res) => {
    await sequelize.transaction(async (transaction) => {
      const role = await PermissionRole.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!role) throw notFound("Papel");
      if (
        await AdminUser.count({
          where: { permissionRoleId: role.id },
          transaction,
        })
      )
        throw new AppError(
          409,
          "ROLE_IN_USE",
          "Remova as atribuições antes de excluir o papel.",
        );
      await audit({
        actor: actorOf(req),
        action: "role.delete",
        entityType: "permission_role",
        entityId: role.id,
        metadata: { before: role.toJSON(), reason: req.valid.body.reason },
        transaction,
      });
      await role.destroy({ transaction });
    });
    res.status(204).end();
  },
);
r.put(
  "/users/:id/role",
  validate({
    params: id,
    body: z.object({ roleId: z.string().uuid().nullable(), reason }).strict(),
  }),
  async (req, res) => {
    await sequelize.transaction(async (transaction) => {
      const u = await AdminUser.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!u || u.deletedAt) throw notFound("Usuário");
      if (u.role === "superadmin")
        throw new AppError(
          409,
          "SUPERADMIN_ROLE",
          "O superadmin mantém suas permissões integrais.",
        );
      const role = req.valid.body.roleId
        ? await PermissionRole.findByPk(req.valid.body.roleId, { transaction })
        : null;
      if (req.valid.body.roleId && (!role || role.baseRole !== u.role))
        throw new AppError(
          422,
          "ROLE_MISMATCH",
          "O papel deve pertencer à mesma função base do usuário.",
        );
      const before = u.permissionRoleId;
      await u.update({ permissionRoleId: role?.id || null }, { transaction });
      await revokeAllSessions(u.id, transaction);
      transaction.afterCommit(() => disconnectAdminUser(u.id));
      await audit({
        actor: actorOf(req),
        action: "user.role.assign",
        entityType: "admin_user",
        entityId: u.id,
        metadata: {
          before,
          after: role?.id || null,
          reason: req.valid.body.reason,
        },
        transaction,
      });
    });
    res.json({ ok: true });
  },
);
r.delete(
  "/users/:id",
  validate({
    params: id,
    body: z
      .object({ reason, confirmation: z.literal("EXCLUIR USUÁRIO") })
      .strict(),
  }),
  async (req, res) => {
    await sequelize.transaction(async (transaction) => {
      await AdminUser.findAll({
        where: { role: "superadmin" },
        order: [["id", "ASC"]],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const u = await AdminUser.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!u || u.deletedAt) throw notFound("Usuário");
      if (u.id === req.user.id)
        throw new AppError(
          409,
          "SELF_DELETE",
          "Você não pode excluir sua própria conta.",
        );
      if (
        u.role === "superadmin" &&
        u.status === "active" &&
        (await AdminUser.count({
          where: {
            role: "superadmin",
            status: "active",
            deletedAt: null,
            id: { [Op.ne]: u.id },
          },
          transaction,
        })) === 0
      )
        throw new AppError(
          409,
          "LAST_SUPERADMIN",
          "Mantenha um superadmin ativo.",
        );
      const before = {
        name: u.name,
        email: u.email,
        role: u.role,
        status: u.status,
      };
      await u.update(
        {
          deletedAt: new Date(),
          status: "disabled",
          passwordResetHash: null,
          passwordResetExpiresAt: null,
          passwordResetIssuedAt: null,
        },
        { transaction },
      );
      await revokeAllSessions(u.id, transaction);
      transaction.afterCommit(() => disconnectAdminUser(u.id));
      await audit({
        actor: actorOf(req),
        action: "user.delete",
        entityType: "admin_user",
        entityId: u.id,
        metadata: {
          before,
          after: { status: "disabled", deleted: true },
          reason: req.valid.body.reason,
        },
        transaction,
      });
    });
    res.status(204).end();
  },
);

r.get(
  "/sessions",
  validate({
    query: z.object({
      ...pageQuery,
      userId: z.string().uuid().optional(),
      q: z.string().trim().max(100).optional(),
    }),
  }),
  async (req, res) => {
    const q = req.valid.query,
      replacements = {
        limit: q.pageSize,
        offset: (q.page - 1) * q.pageSize,
        userId: q.userId || null,
        query: `%${(q.q || "").replace(/[\\%_]/g, "")}%`,
      };
    const where = `s.revoked_at IS NULL AND s.expires_at>now() AND u.deleted_at IS NULL AND (:userId::uuid IS NULL OR u.id=:userId::uuid) AND (u.name ILIKE :query OR u.email ILIKE :query)`;
    const [data, [count]] = await Promise.all([
      sql(
        `SELECT s.id,s.ip,s.user_agent AS "userAgent",s.created_at AS "createdAt",s.expires_at AS "expiresAt",u.id AS "userId",u.name,u.email,u.role FROM auth_sessions s JOIN admin_users u ON u.id=s.admin_user_id WHERE ${where} ORDER BY s.created_at DESC,s.id LIMIT :limit OFFSET :offset`,
        replacements,
      ),
      sql(
        `SELECT count(*)::int total FROM auth_sessions s JOIN admin_users u ON u.id=s.admin_user_id WHERE ${where}`,
        replacements,
      ),
    ]);
    res.json(
      paged(
        data.map((x) => ({ ...x, current: x.id === req.sessionId })),
        count.total,
        q,
      ),
    );
  },
);
r.post(
  "/sessions/:id/revoke",
  validate({ params: id, body: z.object({ reason }).strict() }),
  async (req, res) => {
    let target;
    await sequelize.transaction(async (transaction) => {
      target = await AuthSession.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!target || target.revokedAt) throw notFound("Sessão ativa");
      await target.update({ revokedAt: new Date() }, { transaction });
      await ImpersonationGrant.update(
        { revokedAt: new Date() },
        { where: { sessionId: target.id, revokedAt: null }, transaction },
      );
      await audit({
        actor: actorOf(req),
        action: "session.revoke",
        entityType: "auth_session",
        entityId: target.id,
        metadata: {
          userId: target.adminUserId,
          reason: req.valid.body.reason,
          before: { revoked: false },
          after: { revoked: true },
        },
        transaction,
      });
    });
    disconnectAdminSession(target.adminUserId, target.id);
    res.json({ ok: true, currentSessionRevoked: target.id === req.sessionId });
  },
);
r.post(
  "/users/:id/revoke-sessions",
  validate({ params: id, body: z.object({ reason }).strict() }),
  async (req, res) => {
    await sequelize.transaction(async (transaction) => {
      const u = await AdminUser.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!u) throw notFound("Usuário");
      await revokeAllSessions(u.id, transaction);
      await ImpersonationGrant.update(
        { revokedAt: new Date() },
        {
          where: {
            [Op.or]: [{ actorId: u.id }, { targetId: u.id }],
            revokedAt: null,
          },
          transaction,
        },
      );
      await audit({
        actor: actorOf(req),
        action: "user.sessions.revoke",
        entityType: "admin_user",
        entityId: u.id,
        metadata: { reason: req.valid.body.reason },
        transaction,
      });
    });
    disconnectAdminUser(req.valid.params.id);
    res.json({ ok: true });
  },
);

r.post(
  "/impersonations",
  validate({
    body: z
      .object({
        targetUserId: z.string().uuid(),
        portal: z.enum(["partner", "content_partner"]),
        reason,
      })
      .strict(),
  }),
  async (req, res) => {
    if (!req.sessionId)
      throw new AppError(
        409,
        "SESSION_REQUIRED",
        "Entre novamente antes de impersonar.",
      );
    const { targetUserId, portal, reason } = req.valid.body;
    const result = await sequelize.transaction(async (transaction) => {
      const target = await AdminUser.findByPk(targetUserId, { transaction });
      if (
        !target ||
        target.role !== "partner" ||
        target.status !== "active" ||
        target.deletedAt
      )
        throw new AppError(
          422,
          "INVALID_TARGET",
          "Selecione uma conta ativa de revenda ou parceiro.",
        );
      const partner = await activePartner(target.partnerId, transaction);
      if (
        portal === "content_partner" &&
        !["content", "both"].includes(partner.kind)
      )
        throw new AppError(
          422,
          "WRONG_PORTAL",
          "Esta conta não fornece conteúdo.",
        );
      const grant = await ImpersonationGrant.create(
        {
          actorId: req.user.id,
          targetId: target.id,
          sessionId: req.sessionId,
          reason,
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
        { transaction },
      );
      await audit({
        actor: actorOf(req),
        action: "impersonation.start",
        entityType: "admin_user",
        entityId: target.id,
        metadata: {
          reason,
          grantId: grant.id,
          portal,
          expiresAt: grant.expiresAt,
        },
        transaction,
      });
      return { grant, target };
    });
    const { grant, target } = result;
    const { user } = await resolveAdminClaims({
      sub: target.id,
      tv: target.tokenVersion,
      imp: grant.id,
    });
    res.status(201).json({
      accessToken: signJwt(
        {
          typ: "admin",
          sub: target.id,
          tv: target.tokenVersion,
          imp: grant.id,
        },
        900,
      ),
      user,
      portal,
      impersonation: {
        id: grant.id,
        actorName: req.user.name,
        expiresAt: grant.expiresAt,
      },
    });
  },
);
r.get("/impersonations", async (_req, res) =>
  res.json({
    data: await ImpersonationGrant.findAll({
      where: { revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
      attributes: ["id", "actorId", "targetId", "expiresAt", "createdAt"],
      order: [["createdAt", "DESC"]],
      limit: 100,
    }),
  }),
);
r.delete(
  "/impersonations/:id",
  validate({ params: id, body: z.object({ reason }).strict() }),
  async (req, res) => {
    await sequelize.transaction(async (transaction) => {
      const grant = await ImpersonationGrant.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!grant) throw notFound("Impersonação");
      await grant.update({ revokedAt: new Date() }, { transaction });
      await audit({
        actor: actorOf(req),
        action: "impersonation.end",
        entityType: "impersonation_grant",
        entityId: grant.id,
        metadata: { reason: req.valid.body.reason },
        transaction,
      });
    });
    res.status(204).end();
  },
);

r.post(
  "/licenses/batch",
  validate({
    body: z
      .object({
        planId: z.string().uuid(),
        count: z.number().int().min(1).max(100),
        ownerPartnerId: z.string().uuid().nullable().default(null),
        trialHours: z.number().int().min(1).max(8760).optional(),
        maxDevices: z.number().int().min(1).max(50).optional(),
        idempotencyKey: z.string().uuid(),
        reason,
      })
      .strict(),
  }),
  async (req, res) => {
    const b = req.valid.body,
      operationKey = `batch:${b.idempotencyKey}`,
      hash = sha256(JSON.stringify(b));
    const result = await sequelize.transaction(async (transaction) => {
      await sql(
        "SELECT pg_advisory_xact_lock(hashtext(:key))",
        { key: operationKey },
        transaction,
      );
      const stored = await PlatformSetting.findByPk(operationKey, {
        transaction,
      });
      if (stored) {
        if (stored.value.actorId !== req.user.id || stored.value.hash !== hash)
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Chave já usada em outra operação.",
          );
        return {
          ...JSON.parse(decryptSecret(stored.value.response)),
          reused: true,
        };
      }
      const plan = await Plan.findByPk(b.planId, { transaction });
      if (!plan || !plan.active)
        throw new AppError(
          422,
          "INVALID_PLAN",
          "Plano inexistente ou inativo.",
        );
      await activePartner(b.ownerPartnerId, transaction);
      const data = [],
        now = new Date();
      for (let i = 0; i < b.count; i++) {
        const code = generateCode("LIC"),
          row = await License.create(
            {
              codeHash: hashCode(code),
              codeLast4: code.slice(-4),
              planId: plan.id,
              ownerPartnerId: b.ownerPartnerId,
              status: "active",
              isTrial: !!b.trialHours,
              startsAt: now,
              expiresAt: b.trialHours
                ? new Date(now.getTime() + b.trialHours * 3600000)
                : addLicenseMonthsUTC(now, plan.durationMonths),
              maxDevices: b.maxDevices || plan.maxDevices,
              createdBy: req.user.id,
              assignedAt: b.ownerPartnerId ? now : null,
            },
            { transaction },
          );
        data.push({
          id: row.id,
          code,
          expiresAt: row.expiresAt,
          isTrial: row.isTrial,
        });
      }
      const response = { data };
      await PlatformSetting.create(
        {
          key: operationKey,
          value: {
            actorId: req.user.id,
            hash,
            response: encryptSecret(JSON.stringify(response)),
          },
        },
        { transaction },
      );
      await audit({
        actor: actorOf(req),
        action: "license.batch.create",
        entityType: "license_batch",
        entityId: b.idempotencyKey,
        metadata: {
          count: b.count,
          planId: b.planId,
          ownerPartnerId: b.ownerPartnerId,
          trialHours: b.trialHours,
          reason: b.reason,
          licenseIds: data.map((x) => x.id),
        },
        transaction,
      });
      return response;
    });
    res.status(result.reused ? 200 : 201).json(result);
  },
);
r.patch(
  "/licenses/:id",
  validate({
    params: id,
    body: z
      .object({
        expiresAt: z.string().datetime({ offset: true }).optional(),
        deltaDays: z
          .number()
          .int()
          .min(-3650)
          .max(3650)
          .refine((v) => v !== 0)
          .optional(),
        ownerPartnerId: z.string().uuid().nullable().optional(),
        maxDevices: z.number().int().min(1).max(50).optional(),
        maxSessionsPerActivation: z
          .number()
          .int()
          .min(1)
          .max(20)
          .nullable()
          .optional(),
        reason,
      })
      .strict()
      .refine(
        (b) => !(b.expiresAt && b.deltaDays),
        "Escolha data ou quantidade de dias.",
      )
      .refine(
        (b) =>
          b.expiresAt ||
          b.deltaDays ||
          b.ownerPartnerId !== undefined ||
          b.maxDevices !== undefined ||
          b.maxSessionsPerActivation !== undefined,
        "Informe uma alteração.",
      ),
  }),
  async (req, res) => {
    const result = await sequelize.transaction(async (transaction) => {
      const l = await License.findByPk(req.valid.params.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!l) throw notFound("Licença");
      const b = req.valid.body,
        before = {
          expiresAt: l.expiresAt,
          ownerPartnerId: l.ownerPartnerId,
          maxDevices: l.maxDevices,
          maxSessionsPerActivation: l.maxSessionsPerActivation,
        };
      const changes = {};
      if (b.expiresAt || b.deltaDays) changes.expiresAt = adjustedExpiry(l, b);
      if (b.maxDevices !== undefined) {
        const count = await Activation.count({
          where: {
            [Op.or]: [{ licenseId: l.id }, { grantedLicenseId: l.id }],
            status: { [Op.ne]: "revoked" },
          },
          transaction,
        });
        if (b.maxDevices < count)
          throw new AppError(
            409,
            "LIMIT_BELOW_USAGE",
            `Existem ${count} vínculos. Remova os excedentes antes de reduzir o limite.`,
          );
        changes.maxDevices = b.maxDevices;
      }
      if (b.ownerPartnerId !== undefined) {
        await activePartner(b.ownerPartnerId, transaction);
        const content = await Activation.count({
          where: {
            grantedLicenseId: l.id,
            partnerId: { [Op.ne]: null },
            status: { [Op.ne]: "revoked" },
          },
          transaction,
        });
        if (content && b.ownerPartnerId !== l.ownerPartnerId)
          throw new AppError(
            409,
            "CONTENT_BINDING",
            "Esta licença atende uma lista de conteúdo. Use a transferência de ativação com reconfiguração do provedor.",
          );
        changes.ownerPartnerId = b.ownerPartnerId;
      }
      if (b.maxSessionsPerActivation !== undefined) {
        changes.maxSessionsPerActivation = b.maxSessionsPerActivation;
        if (b.maxSessionsPerActivation !== null) {
          const activations = await Activation.findAll({
            where: {
              [Op.or]: [{ licenseId: l.id }, { grantedLicenseId: l.id }],
              status: { [Op.ne]: "revoked" },
            },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          for (const a of activations) {
            const sessions = await DeviceSession.findAll({
              where: { activationId: a.id, revokedAt: null },
              transaction,
              lock: transaction.LOCK.UPDATE,
            });
            const ids = sessionsToRevoke(
              sessions.map((s) => s.toJSON()),
              b.maxSessionsPerActivation + 1,
            );
            if (ids.length)
              await DeviceSession.update(
                { revokedAt: new Date() },
                { where: { id: { [Op.in]: ids } }, transaction },
              );
          }
        }
      }
      await l.update(changes, { transaction });
      await audit({
        actor: actorOf(req),
        action: "license.override",
        entityType: "license",
        entityId: l.id,
        metadata: {
          reason: b.reason,
          before,
          after: {
            expiresAt: l.expiresAt,
            ownerPartnerId: l.ownerPartnerId,
            maxDevices: l.maxDevices,
            maxSessionsPerActivation: l.maxSessionsPerActivation,
          },
        },
        transaction,
      });
      return { id: l.id, ...changes };
    });
    clearMirrorAuth();
    res.json(result);
  },
);

// Export complete filtered result pages, never only the visible page. Limit is explicit.
r.get(
  "/licenses/export",
  validate({
    query: z.object({
      status: z
        .enum(["all", "active", "expired", "suspended", "trial", "expiring"])
        .default("all"),
      ownerPartnerId: z.string().uuid().optional(),
    }),
  }),
  async (req, res) => {
    const q = req.valid.query,
      now = new Date(),
      where = {};
    if (q.ownerPartnerId) where.ownerPartnerId = q.ownerPartnerId;
    if (q.status === "trial") where.isTrial = true;
    if (q.status === "suspended") where.status = "suspended";
    if (["active", "expired", "expiring"].includes(q.status)) {
      where.status = "active";
      where.expiresAt =
        q.status === "expired"
          ? { [Op.lte]: now }
          : q.status === "expiring"
            ? { [Op.between]: [now, new Date(+now + 7 * 86400000)] }
            : { [Op.gt]: now };
    }
    const rows = await License.findAll({
      where,
      attributes: [
        "id",
        "ownerPartnerId",
        "status",
        "isTrial",
        "startsAt",
        "expiresAt",
        "maxDevices",
      ],
      order: [["id", "ASC"]],
      limit: 10001,
      raw: true,
    });
    if (rows.length > 10000)
      throw new AppError(
        422,
        "EXPORT_LIMIT",
        "Refine os filtros para exportar até 10 mil licenças.",
      );
    const columns = [
      "id",
      "ownerPartnerId",
      "status",
      "isTrial",
      "startsAt",
      "expiresAt",
      "maxDevices",
    ];
    const csv =
      "\uFEFF" +
      [
        columns.map(csvCell).join(";"),
        ...rows.map((x) =>
          columns
            .map((c) =>
              csvCell(x[c] instanceof Date ? x[c].toISOString() : x[c]),
            )
            .join(";"),
        ),
      ].join("\r\n");
    res.json({ filename: "licencas.csv", content: csv, count: rows.length });
  },
);

const periodQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  partnerId: z.string().uuid().optional(),
});
r.get("/reports", validate({ query: periodQuery }), async (req, res) => {
  const { start, end } = reportPeriod(req.valid.query),
    partnerId = req.valid.query.partnerId || null;
  const params = { start, end, partnerId };
  const scope = `WITH RECURSIVE scope AS (SELECT id FROM partners WHERE :partnerId::uuid IS NULL OR id=:partnerId::uuid UNION SELECT p.id FROM partners p JOIN scope s ON p.parent_partner_id=s.id), receipts AS (
 SELECT pay.id,pay.amount_cents,pay.paid_at,COALESCE(i.partner_id,l.owner_partner_id) AS partner_id FROM payments pay LEFT JOIN invoices i ON i.id=pay.invoice_id LEFT JOIN licenses l ON l.id=pay.license_id WHERE pay.status='confirmed'
 UNION ALL SELECT c.id,COALESCE(c.paid_amount_cents,c.amount_cents),c.paid_at,c.partner_id FROM pix_charges c WHERE c.status='paid' AND c.payment_id IS NULL)`;
  const paid = `FROM receipts pay WHERE pay.paid_at >= :start AND pay.paid_at < :end AND (:partnerId::uuid IS NULL OR pay.partner_id IN (SELECT id FROM scope))`;
  const [
    daily,
    top,
    [finance],
    [licenses],
    [clients],
    growth,
    [network],
    [activeClients],
  ] = await Promise.all([
    sql(
      `${scope} SELECT to_char(pay.paid_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS \"day\",sum(pay.amount_cents)::text AS "revenueCents",count(*)::int payments ${paid} GROUP BY 1 ORDER BY 1`,
      params,
    ),
    sql(
      `${scope} SELECT pay.partner_id id,max((SELECT name FROM partners WHERE id=pay.partner_id)) name,sum(pay.amount_cents)::text AS "revenueCents" ${paid} GROUP BY 1 ORDER BY sum(pay.amount_cents) DESC LIMIT 10`,
      params,
    ),
    sql(
      `${scope} SELECT COALESCE(sum(pay.amount_cents),0)::text AS "revenueCents",count(*)::int payments ${paid}`,
      params,
    ),
    sql(
      `${scope} SELECT count(*) FILTER(WHERE NOT is_trial AND status='active' AND starts_at<=now() AND expires_at>now())::int active,count(*) FILTER(WHERE status='active' AND starts_at<=now() AND expires_at>now() AND expires_at<=now()+interval '7 days')::int expiring,count(*) FILTER(WHERE is_trial AND starts_at<=now() AND expires_at>now() AND status='active')::int trials FROM licenses WHERE (:partnerId::uuid IS NULL OR owner_partner_id IN (SELECT id FROM scope))`,
      params,
    ),
    sql(
      `${scope} SELECT count(*)::int total,count(*) FILTER(WHERE due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date)::int overdue,COALESCE(sum(price_cents) FILTER(WHERE due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date),0)::text AS "overdueCents" FROM reseller_clients WHERE (:partnerId::uuid IS NULL OR partner_id IN (SELECT id FROM scope))`,
      params,
    ),
    sql(
      `${scope} SELECT to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS \"day\",count(*)::int created FROM reseller_clients WHERE created_at >= :start AND created_at < :end AND (:partnerId::uuid IS NULL OR partner_id IN (SELECT id FROM scope)) GROUP BY 1 ORDER BY 1`,
      params,
    ),
    sql(
      `${scope} SELECT COALESCE(sum(total_cents),0)::text AS \"networkRevenueCents\" FROM reseller_master_pix_orders WHERE status='paid' AND paid_at >= :start AND paid_at < :end AND (:partnerId::uuid IS NULL OR seller_partner_id IN (SELECT id FROM scope))`,
      params,
    ),
    // Same access branches as access.policy.js, including partner_only and grace periods.
    sql(
      `${scope}, debt AS (SELECT partner_id,min(due_date) AS due FROM invoices WHERE status IN ('open','partial','overdue') GROUP BY partner_id)
    SELECT count(DISTINCT a.device_id)::int AS total FROM activations a
    LEFT JOIN licenses l ON l.id=a.license_id LEFT JOIN licenses g ON g.id=a.granted_license_id
    LEFT JOIN partners p ON p.id=a.partner_id LEFT JOIN content_partner_terms t ON t.partner_id=p.id
    LEFT JOIN partner_codes c ON c.id=a.partner_code_id LEFT JOIN debt d ON d.partner_id=p.id
    WHERE a.status='active' AND COALESCE(l.is_trial,g.is_trial,false) = false AND (p.id IS NULL OR p.status<>'deleted')
    AND ((l.id IS NOT NULL AND l.status='active' AND l.starts_at<=now() AND l.expires_at>now())
      OR (l.id IS NULL AND g.id IS NOT NULL AND g.status='active' AND g.starts_at<=now() AND g.expires_at>now() AND p.status NOT IN ('blocked','cancelled'))
      OR (l.id IS NULL AND g.id IS NULL AND p.status='active' AND p.starts_at<=now() AND p.ends_at>now() AND (p.suspend_policy<>'auto_after_grace' OR d.due IS NULL OR (now() AT TIME ZONE 'UTC')::date-d.due<=p.grace_days)))
    AND (t.license_policy IS DISTINCT FROM 'partner_only' OR (c.status='active' AND (c.expires_at IS NULL OR c.expires_at>now()) AND p.status='active' AND p.starts_at<=now() AND p.ends_at>now() AND (p.suspend_policy<>'auto_after_grace' OR d.due IS NULL OR (now() AT TIME ZONE 'UTC')::date-d.due<=p.grace_days)))
    AND (:partnerId::uuid IS NULL OR a.partner_id IN (SELECT id FROM scope) OR COALESCE(l.owner_partner_id,g.owner_partner_id) IN (SELECT id FROM scope))`,
      params,
    ),
  ]);
  res.json({
    period: { from: start, to: end },
    finance: { ...finance, ...network },
    licenses,
    clients: { ...clients, active: activeClients.total },
    daily,
    top,
    growth,
    notes:
      "Recebimentos da plataforma: pagamentos confirmados e Pix pagos sem pagamento duplicado. Recebimentos da rede: Pix recebido diretamente por Masters, separado da plataforma. Estornos e cobranças em revisão não entram. Atraso: vencimento da ficha de atendimento. Clientes ativos: aparelhos distintos com acesso autorizado, mesmo offline; não são pessoas únicas.",
  });
});

const controls = z
  .object({
    maintenance: z.boolean(),
    maintenanceMessage: z.string().trim().min(5).max(500),
    brand: z
      .object({
        name: z.string().trim().min(2).max(80),
        logoUrl: z.union([
          z.literal(""),
          z
            .string()
            .url()
            .max(500)
            .refine((v) => v.startsWith("https://"), "Use HTTPS."),
        ]),
        primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i),
      })
      .strict(),
    terms: z.string().max(20000),
    integrations: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_-]{1,39}$/),
            enabled: z.boolean(),
            secret: z.string().max(4000).optional(),
          })
          .strict(),
      )
      .max(10)
      .refine(
        (items) => new Set(items.map((x) => x.name)).size === items.length,
        "Nome de integração duplicado.",
      ),
    reason,
  })
  .strict();
r.get("/settings", async (_req, res) =>
  res.json(presentControls(await readControls())),
);
r.put("/settings", validate({ body: controls }), async (req, res) =>
  res.json(await saveControls(req.valid.body, actorOf(req))),
);
const password = z.string().min(16).max(200),
  envelope = z
    .object({
      format: z.literal("deltatv-backup-v1"),
      salt: z.string().max(32),
      iv: z.string().max(24),
      tag: z.string().max(32),
      data: z.string().max(28000000),
    })
    .strict();
r.post(
  "/data/export",
  validate({ body: z.object({ password, reason }).strict() }),
  async (req, res) =>
    res.json(await exportData(req.valid.body.password, actorOf(req))),
);
r.post(
  "/data/import/preview",
  validate({ body: z.object({ password, backup: envelope }).strict() }),
  async (req, res) =>
    res.json({
      ...(await previewImport(req.valid.body.backup, req.valid.body.password)),
      hash: backupHash(req.valid.body.backup),
    }),
);
r.post(
  "/data/import/apply",
  validate({
    body: z
      .object({
        password,
        backup: envelope,
        reason,
        expectedHash: z.string().length(64),
        confirmation: z.literal("IMPORTAR BACKUP"),
      })
      .strict(),
  }),
  async (req, res) => res.json(await importData(req.valid.body, actorOf(req))),
);
export default r;
