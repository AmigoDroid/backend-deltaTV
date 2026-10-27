import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { loginLimiter, refreshLimiter, signupLimiter } from "../../middleware/security.js";
import { authenticate } from "../../middleware/authenticate.js";
import { AdminUser } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { hashPassword, verifyPassword } from "../../shared/crypto.js";
import * as svc from "./auth.service.js";
import { registerReseller } from "../partners/reseller-signup.service.js";

const router = Router();
const meta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

router.post(
  "/login", loginLimiter,
  // `audience` separa os dois painéis: o painel admin envia "admin", o portal do revendedor envia "partner".
  // Conta do outro tipo recebe o mesmo erro de senha inválida (não revela que o e-mail existe).
  validate({ body: z.object({ email: z.string().email().max(200), password: z.string().min(1).max(128), audience: z.enum(["admin", "partner"]).optional() }) }),
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
    const user = await AdminUser.findByPk(req.user.id);
    if (!(await verifyPassword(req.valid.body.currentPassword, user.passwordHash))) {
      throw new AppError(400, "INVALID_CREDENTIALS", "Senha atual incorreta.");
    }
    await user.update({ passwordHash: await hashPassword(req.valid.body.newPassword) });
    await svc.revokeAllSessions(user.id); // derruba todas as sessões, inclusive a atual
    res.status(204).end();
  },
);

export default router;
