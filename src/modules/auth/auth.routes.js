import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { loginLimiter, refreshLimiter, signupLimiter } from "../../middleware/security.js";
import { authenticate } from "../../middleware/authenticate.js";
import { sequelize, AdminUser } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { hashPassword, verifyPassword } from "../../shared/crypto.js";
import * as svc from "./auth.service.js";
import history from "./login-history.routes.js";
import { disconnectAdminUser } from "../../realtime/socket.js";
import { registerReseller } from "../partners/reseller-signup.service.js";
import { verifyPreRegistration, completePreRegistration } from "../partners/partner-invite.service.js";

const router = Router();
router.use("/history", history);
const meta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

router.post(
  "/login", loginLimiter,
  // `audience` separa os dois painéis: o painel admin envia "admin", o portal do revendedor envia "partner".
  // Conta do outro tipo recebe o mesmo erro de senha inválida (não revela que o e-mail existe).
  validate({ body: z.object({ email: z.string().email().max(200), password: z.string().min(1).max(128), audience: z.enum(["admin", "partner", "content_partner"]).optional() }) }),
  async (req, res) => res.json(await svc.login(req.valid.body, meta(req))),
);

// Autocadastro de revendedor (público). O cadastro fica aguardando aprovação do admin. Resposta igual para qualquer e-mail.
const SIGNUP_OK = { ok: true, message: "Cadastro recebido. Você poderá entrar assim que a plataforma aprovar." };
router.post(
  "/register-reseller", signupLimiter,
  validate({ body: z.object({
    name: z.string().trim().min(2).max(160).optional(), contactName: z.string().trim().min(2).max(160),
    email: z.string().trim().email().max(200), phone: z.string().trim().min(8).max(40),
    password: z.string().min(12).max(128),
    website: z.string().max(200).optional(), // isca anti-robô: campo invisível; se vier preenchido, ignora em silêncio
  }) }),
  async (req, res) => {
    const { website, ...input } = req.valid.body;
    if (!website) await registerReseller(input, meta(req));
    res.status(202).json(SIGNUP_OK);
  },
);

// Endpoints públicos: o segredo viaja SOMENTE no corpo POST (nunca no log de URL).
const invitationToken = z.string().min(32).max(100).regex(/^[A-Za-z0-9_-]+$/);
router.post("/partner-invite/verify", loginLimiter,
  validate({ body: z.object({ token: invitationToken }).strict() }),
  async (req, res) => res.set("Cache-Control", "no-store").json(await verifyPreRegistration(req.valid.body.token)));
router.post("/partner-invite/complete", signupLimiter,
  validate({ body: z.object({
    token: invitationToken, companyName: z.string().trim().min(2).max(160), password: z.string().min(12).max(128),
  }).strict() }),
  async (req, res) => res.set("Cache-Control", "no-store").json(await completePreRegistration(req.valid.body)));

router.post(
  "/refresh", refreshLimiter,
  validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }),
  async (req, res) => res.json(await svc.refresh(req.valid.body.refreshToken, meta(req))),
);

router.post(
  "/logout",
  validate({ body: z.object({ refreshToken: z.string().max(200).optional() }) }),
  async (req, res) => {
    await svc.logout(req.valid.body.refreshToken);
    res.status(204).end();
  },
);

router.get("/me", authenticate, async (req, res) => res.json({ user: req.user }));

router.post(
  "/change-password", authenticate,
  validate({ body: z.object({ currentPassword: z.string().max(128), newPassword: z.string().min(12).max(128) }) }),
  async (req, res) => {
    const passwordHash = await hashPassword(req.valid.body.newPassword);
    await sequelize.transaction(async transaction => {
      const user = await AdminUser.findByPk(req.user.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!user || !(await verifyPassword(req.valid.body.currentPassword, user.passwordHash))) {
        throw new AppError(400, "INVALID_CREDENTIALS", "Senha atual incorreta.");
      }
      await user.update({ passwordHash }, { transaction });
      await svc.revokeAllSessions(user.id, transaction);
    });
    disconnectAdminUser(req.user.id);
    res.status(204).end();
  },
);

export default router;
