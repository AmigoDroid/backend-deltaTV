import { Router } from "express";
import { z } from "zod";
import { AdminUser, Partner } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery, pageOf, paged } from "../../shared/pagination.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { revokeAllSessions } from "../auth/auth.service.js";

// Gestão de usuários: somente superadmin ("users:manage" não consta nas demais funções).
const router = Router();
const id = z.object({ id: z.string().uuid() });
const safe = (u) => { const j = u.toJSON(); delete j.passwordHash; return j; };

router.use(requirePermission("users:manage"));

router.get("/", validate({ query: z.object({ ...pageQuery }) }), async (req, res) => {
  const { rows, count } = await AdminUser.findAndCountAll({ order: [["createdAt", "DESC"]], ...pageOf(req.valid.query) });
  res.json(paged(rows.map(safe), count, req.valid.query));
});

router.post(
  "/", validate({ body: z.object({ name: z.string().min(2).max(160), email: z.string().email().max(200), password: z.string().min(12).max(128), role: z.enum(["superadmin", "admin", "support", "partner"]), partnerId: z.string().uuid().optional() }) }),
  async (req, res) => {
    const b = req.valid.body;
    if ((b.role === "partner") !== !!b.partnerId) throw new AppError(422, "PARTNER_REQUIRED", "Usuários 'partner' exigem partnerId (e somente eles).");
    if (b.partnerId && !(await Partner.findByPk(b.partnerId))) throw new AppError(422, "INVALID_PARTNER", "Parceiro inexistente.");
    const u = await AdminUser.create({ name: b.name, email: b.email, passwordHash: await hashPassword(b.password), role: b.role, partnerId: b.partnerId ?? null });
    await audit({ actor: actorOf(req), action: "user.create", entityType: "admin_user", entityId: u.id, metadata: { role: b.role } });
    res.status(201).json(safe(u));
  },
);

router.patch(
  "/:id", validate({ params: id, body: z.object({ name: z.string().min(2).max(160).optional(), status: z.enum(["active", "disabled"]).optional(), password: z.string().min(12).max(128).optional() }) }),
  async (req, res) => {
    const u = await AdminUser.findByPk(req.valid.params.id);
    if (!u) throw notFound("Usuário");
    const { password, ...rest } = req.valid.body;
    if (u.id === req.user.id && rest.status === "disabled") throw new AppError(409, "SELF_DISABLE", "Você não pode desativar a própria conta.");
    await u.update({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) });
    if (password || rest.status === "disabled") await revokeAllSessions(u.id);
    await audit({ actor: actorOf(req), action: "user.update", entityType: "admin_user", entityId: u.id, metadata: { ...rest, passwordChanged: !!password } });
    res.json(safe(u));
  },
);

export default router;
