import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { loginLimiter, refreshLimiter } from "../../middleware/security.js";
import { authenticate } from "../../middleware/authenticate.js";
import { AdminUser } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { hashPassword, verifyPassword } from "../../shared/crypto.js";
import * as svc from "./auth.service.js";

const router = Router();
const meta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

router.post(
  "/login", loginLimiter,
  validate({ body: z.object({ email: z.string().email().max(200), password: z.string().min(1).max(128) }) }),
  async (req, res) => res.json(await svc.login(req.valid.body, meta(req))),
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
