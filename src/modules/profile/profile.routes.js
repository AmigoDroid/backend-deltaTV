/** Minha Conta — só o titular autenticado; NUNCA aceita partnerId/userId do cliente. */
import { Router } from "express";
import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, AdminUser, AdminUserProfile, Partner, AuthSession, AuditLog, LoginHistory } from "../../db/models/index.js";
import { authenticate, requirePartnerRole } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { AppError } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { verifyPassword } from "../../shared/crypto.js";
import { profileSensitiveLimiter } from "../../middleware/security.js";
import { revokeAllSessions } from "../auth/auth.service.js";
import { disconnectAdminUser, disconnectAdminSession } from "../../realtime/socket.js";

const r = Router();
r.use(authenticate, requirePartnerRole);
r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const publicProfile = p => ({ phone: p?.phone || "", avatarData: p?.avatarData || null,
  showUnreadBanner: p?.showUnreadBanner !== false, showNotificationBadge: p?.showNotificationBadge !== false });
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, lastLoginAt: u.lastLoginAt });
const getProfile = id => AdminUserProfile.findByPk(id);

r.get("/", async (req, res) => {
  const [user, profile, partner] = await Promise.all([
    AdminUser.findByPk(req.user.id, { attributes: ["id", "name", "email", "role", "lastLoginAt"] }),
    getProfile(req.user.id),
    Partner.findByPk(req.user.partnerId, { attributes: ["id", "name", "kind", "status", "startsAt", "endsAt", "billingModel", "deviceLimit"] }),
  ]);
  if (!user || !partner) throw new AppError(404, "NOT_FOUND", "Conta não encontrada.");
  res.json({ user: publicUser(user), profile: publicProfile(profile), partner });
});

// Upsert concorrente sem consultar/destravar registros de outro usuário.
async function updateProfile(userId, fields, transaction) {
  // Atualiza SOMENTE os campos enviados: upsert(model) poderia aplicar defaults
  // e restaurar acidentalmente preferências ao editar foto ou telefone.
  // Atualizar explicitamente updatedAt no ON CONFLICT. Sem isso, uma troca de foto
  // não mudaria a revisão exibida no Superadmin e a imagem ficaria em cache.
  await AdminUserProfile.bulkCreate([{ adminUserId: userId, ...fields, updatedAt: new Date() }], {
    updateOnDuplicate: [...Object.keys(fields), "updatedAt"], transaction,
  });
}

r.patch("/", validate({ body: z.object({ name: z.string().trim().min(2).max(160), phone: z.string().trim().max(40).nullable() }).strict() }), async (req, res) => {
  const { name, phone } = req.valid.body;
  const result = await sequelize.transaction(async transaction => {
    const user = await AdminUser.findByPk(req.user.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user) throw new AppError(404, "NOT_FOUND", "Conta não encontrada.");
    await user.update({ name }, { transaction });
    // Atualizar mesmo quando somente o telefone muda.
    await updateProfile(user.id, { phone: phone || null }, transaction);
    await audit({ actor: actorOf(req), action: "profile.update", entityType: "admin_user", entityId: user.id,
      metadata: { fields: ["name", "phone"] }, transaction });
    return publicUser(user);
  });
  res.json({ user: result });
});

const EMAIL_SCHEMA = z.object({ email: z.string().trim().email().max(200), currentPassword: z.string().min(1).max(128) }).strict();
r.post("/email", profileSensitiveLimiter, validate({ body: EMAIL_SCHEMA }), async (req, res) => {
  const { email, currentPassword } = req.valid.body;
  const normalizedEmail = email.toLowerCase();
  let changed = false;
  try {
    changed = await sequelize.transaction(async transaction => {
      const user = await AdminUser.findByPk(req.user.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!user || !(await verifyPassword(currentPassword, user.passwordHash)))
        throw new AppError(400, "INVALID_CREDENTIALS", "Senha atual incorreta.");
      if (user.email.toLowerCase() === normalizedEmail) return false;
      const duplicate = await AdminUser.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), normalizedEmail), transaction, attributes: ["id"] });
      if (duplicate) throw new AppError(409, "EMAIL_IN_USE", "Este e-mail já está cadastrado.");
      await user.update({ email: normalizedEmail, passwordResetHash: null, passwordResetExpiresAt: null, passwordResetIssuedAt: null }, { transaction });
      await revokeAllSessions(user.id, transaction);
      await audit({ actor: actorOf(req), action: "profile.email.change", entityType: "admin_user", entityId: user.id,
        metadata: { changed: true }, transaction });
      return true;
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw new AppError(409, "EMAIL_IN_USE", "Este e-mail já está cadastrado.");
    throw error;
  }
  if (changed) disconnectAdminUser(req.user.id);
  res.json({ ok: true, reauthenticationRequired: changed });
});

// Avatar em formato data URI, limite de 96 KiB. Só JPEG/PNG/WebP por assinatura.
export function validateAvatarData(value) {
  if (value === null) return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > 131072) throw new AppError(422, "INVALID_AVATAR", "Selecione uma imagem PNG, JPEG ou WebP válida de até 96 KB.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 96 * 1024 || bytes.toString("base64") !== match[2]) throw new AppError(422, "INVALID_AVATAR", "Imagem inválida ou muito grande.");
  const mime = match[1];
  const png = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpg = bytes.length > 8 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length > 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!(mime === "png" && png || mime === "jpeg" && jpg || mime === "webp" && webp))
    throw new AppError(422, "INVALID_AVATAR", "Formato de imagem não reconhecido.");
  return value;
}
r.patch("/avatar", validate({ body: z.object({ avatarData: z.string().max(131110).nullable() }).strict() }), async (req, res) => {
  const avatarData = validateAvatarData(req.valid.body.avatarData);
  await sequelize.transaction(async transaction => {
    await updateProfile(req.user.id, { avatarData }, transaction);
    await audit({ actor: actorOf(req), action: "profile.avatar.change", entityType: "admin_user", entityId: req.user.id, transaction });
  });
  res.json({ ok: true, avatarData });
});

r.patch("/preferences", validate({ body: z.object({ showUnreadBanner: z.boolean(), showNotificationBadge: z.boolean() }).strict() }), async (req, res) => {
  await sequelize.transaction(async transaction => {
    await updateProfile(req.user.id, req.valid.body, transaction);
    await audit({ actor: actorOf(req), action: "profile.preferences.update", entityType: "admin_user", entityId: req.user.id,
      metadata: req.valid.body, transaction });
  });
  res.json({ ok: true, preferences: req.valid.body });
});

const PAGE = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(50).default(10) });
r.get("/sessions", validate({ query: PAGE }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const { rows, count } = await AuthSession.findAndCountAll({
    where: { adminUserId: req.user.id, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["id", "ip", "userAgent", "createdAt", "expiresAt"],
    order: [["createdAt", "DESC"]], offset: (page - 1) * limit, limit,
  });
  res.json({ data: rows.map(s => ({ ...s.get({ plain: true }), current: s.id === req.sessionId })),
    meta: { page, limit, total: count, pages: Math.ceil(count / limit) } });
});
const sessionParams = z.object({ id: z.string().uuid() });
r.delete("/sessions/:id", validate({ params: sessionParams }), async (req, res) => {
  const sessionId = req.valid.params.id;
  const [affected] = await AuthSession.update({ revokedAt: new Date() }, {
    where: { id: sessionId, adminUserId: req.user.id, revokedAt: null },
  });
  if (!affected) throw new AppError(404, "NOT_FOUND", "Sessão ativa não encontrada.");
  await audit({ actor: actorOf(req), action: "profile.session.revoke", entityType: "auth_session", entityId: sessionId });
  disconnectAdminSession(req.user.id, sessionId);
  res.json({ ok: true, currentSessionRevoked: sessionId === req.sessionId });
});
r.post("/sessions/revoke-others", async (req, res) => {
  if (!req.sessionId) throw new AppError(409, "SESSION_REFRESH_REQUIRED", "Atualize a sessão antes de desconectar outras sessões.");
  const [revoked] = await AuthSession.update({ revokedAt: new Date() }, {
    where: { adminUserId: req.user.id, id: { [Op.ne]: req.sessionId }, revokedAt: null },
  });
  // Fecha conexões em tempo real das outras sessões, preservando a atual.
  disconnectAdminSession(req.user.id, req.sessionId, { except: true });
  await audit({ actor: actorOf(req), action: "profile.session.revoke_others", entityType: "admin_user", entityId: req.user.id,
    metadata: { revoked } });
  res.json({ ok: true, revoked });
});

r.get("/history", validate({ query: PAGE }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const { rows, count } = await LoginHistory.findAndCountAll({
    where: { adminUserId: req.user.id },
    attributes: ["id", "outcome", "reason", "ip", "city", "region", "country", "browser", "os", "device", "createdAt"],
    offset: (page - 1) * limit, limit, order: [["createdAt", "DESC"]],
  });
  res.json({ data: rows, meta: { page, limit, total: count, pages: Math.ceil(count / limit) } });
});

r.get("/activity", validate({ query: PAGE }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const { rows, count } = await AuditLog.findAndCountAll({
    where: { actorId: String(req.user.id), actorType: "partner" },
    attributes: ["id", "action", "entityType", "result", "createdAt"],
    offset: (page - 1) * limit, limit, order: [["createdAt", "DESC"]],
  });
  res.json({ data: rows, meta: { page, limit, total: count, pages: Math.ceil(count / limit) } });
});

export default r;
