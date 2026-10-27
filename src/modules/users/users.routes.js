import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { AdminUser, Partner } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery, pageOf, paged } from "../../shared/pagination.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { can } from "../../middleware/authenticate.js";
import { revokeAllSessions } from "../auth/auth.service.js";

/**
 * Gestão de usuários.
 *  - superadmin ("users:manage"): todos os usuários e todas as funções.
 *  - admin ("partner-users:manage"): só usuários do PORTAL de revendas/parceiros (role "partner"): cria, edita e redefine senha,
 *    mas não enxerga nem promove contas da equipe (isso evitaria um admin criar um superadmin).
 */
const router = Router();
const id = z.object({ id: z.string().uuid() });
const safe = (u, partner) => { const j = u.toJSON(); delete j.passwordHash; return { ...j, partnerName: partner?.name ?? null }; };
const ROLES = ["superadmin", "admin", "support", "partner"];

router.use((req, _res, next) => {
  if (can(req.user.role, "users:manage")) req.userScope = "all";
  else if (can(req.user.role, "partner-users:manage")) req.userScope = "partner";
  else throw new AppError(403, "FORBIDDEN", "Você não tem permissão para esta operação.");
  next();
});

const partnerNames = async (users) => {
  const ids = [...new Set(users.map((u) => u.partnerId).filter(Boolean))];
  const list = ids.length ? await Partner.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name"] }) : [];
  return Object.fromEntries(list.map((p) => [p.id, p]));
};
const present = async (u) => safe(u, u.partnerId ? await Partner.findByPk(u.partnerId, { attributes: ["id", "name"] }) : null);
const forbiddenRole = () => new AppError(403, "FORBIDDEN", "Seu perfil só gerencia usuários do portal de parceiros.");

router.get("/", validate({ query: z.object({
  ...pageQuery, q: z.string().trim().max(100).optional(), role: z.enum(ROLES).optional(),
  status: z.enum(["active", "disabled"]).optional(), partnerId: z.string().uuid().optional(),
}) }), async (req, res) => {
  const { q, role, status, partnerId } = req.valid.query;
  const where = {};
  // Escopo "partner": filtrar por outra função não encontra nada (e nunca revela contas da equipe).
  if (req.userScope === "partner" && role && role !== "partner") return res.json(paged([], 0, req.valid.query));
  where.role = req.userScope === "partner" ? "partner" : role;
  if (!where.role) delete where.role;
  if (status) where.status = status;
  if (partnerId) where.partnerId = partnerId;
  if (q) { const like = `%${q.replace(/[%_\\]/g, "")}%`; where[Op.or] = [{ name: { [Op.iLike]: like } }, { email: { [Op.iLike]: like } }]; }
  const { rows, count } = await AdminUser.findAndCountAll({ where, order: [["createdAt", "DESC"]], ...pageOf(req.valid.query) });
  const names = await partnerNames(rows);
  res.json(paged(rows.map((u) => safe(u, names[u.partnerId])), count, req.valid.query));
});

router.post(
  "/", validate({ body: z.object({ name: z.string().min(2).max(160), email: z.string().email().max(200), password: z.string().min(12).max(128), role: z.enum(ROLES), partnerId: z.string().uuid().optional() }) }),
  async (req, res) => {
    const b = req.valid.body;
    if (req.userScope === "partner" && b.role !== "partner") throw forbiddenRole();
    if ((b.role === "partner") !== !!b.partnerId) throw new AppError(422, "PARTNER_REQUIRED", "Usuários 'partner' exigem partnerId (e somente eles).");
    if (b.partnerId && !(await Partner.findByPk(b.partnerId))) throw new AppError(422, "INVALID_PARTNER", "Parceiro inexistente.");
    const u = await AdminUser.create({ name: b.name, email: b.email, passwordHash: await hashPassword(b.password), role: b.role, partnerId: b.partnerId ?? null });
    await audit({ actor: actorOf(req), action: "user.create", entityType: "admin_user", entityId: u.id, metadata: { role: b.role, partnerId: b.partnerId ?? null } });
    res.status(201).json(await present(u));
  },
);

router.patch(
  "/:id", validate({ params: id, body: z.object({
    name: z.string().min(2).max(160).optional(), email: z.string().email().max(200).optional(),
    status: z.enum(["active", "disabled"]).optional(), password: z.string().min(12).max(128).optional(),
    role: z.enum(ROLES).optional(), partnerId: z.string().uuid().nullable().optional(),
  }).refine((b) => Object.keys(b).length > 0, "Nada para alterar.") }),
  async (req, res) => {
    const u = await AdminUser.findByPk(req.valid.params.id);
    if (!u) throw notFound("Usuário");
    if (req.userScope === "partner" && (u.role !== "partner" || (req.valid.body.role && req.valid.body.role !== "partner"))) throw forbiddenRole();
    const { password, ...rest } = req.valid.body;
    const self = u.id === req.user.id;
    if (self && rest.status === "disabled") throw new AppError(409, "SELF_DISABLE", "Você não pode desativar a própria conta.");
    if (self && rest.role && rest.role !== u.role) throw new AppError(409, "SELF_ROLE", "Você não pode alterar a própria função.");

    // Função x parceiro: "partner" sempre com parceiro; as demais, nunca.
    const role = rest.role ?? u.role;
    const partnerId = rest.partnerId !== undefined ? rest.partnerId : (role === "partner" ? u.partnerId : null);
    if ((role === "partner") !== !!partnerId) throw new AppError(422, "PARTNER_REQUIRED", "Usuários 'partner' exigem um parceiro (e somente eles).");
    if (partnerId && !(await Partner.findByPk(partnerId))) throw new AppError(422, "INVALID_PARTNER", "Parceiro inexistente.");
    const changes = { ...rest, role, partnerId };

    // Nunca deixar a plataforma sem superadmin ativo.
    const losesSuper = u.role === "superadmin" && u.status === "active" && (role !== "superadmin" || changes.status === "disabled");
    if (losesSuper && (await AdminUser.count({ where: { role: "superadmin", status: "active", id: { [Op.ne]: u.id } } })) === 0) {
      throw new AppError(409, "LAST_SUPERADMIN", "É preciso manter ao menos um superadmin ativo.");
    }

    const sensitive = !!password || changes.status === "disabled" || role !== u.role || partnerId !== u.partnerId || (changes.email && changes.email !== u.email);
    await u.update({ ...changes, ...(password ? { passwordHash: await hashPassword(password) } : {}) });
    if (sensitive) await revokeAllSessions(u.id);
    await audit({ actor: actorOf(req), action: "user.update", entityType: "admin_user", entityId: u.id, metadata: { ...rest, partnerId, passwordChanged: !!password } });
    res.json(await present(u));
  },
);

export default router;
