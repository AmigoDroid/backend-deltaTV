import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { deviceKeyIpLimiter, deviceKeyMacLimiter } from "../../middleware/security.js";
import { configurationSchema } from "./device-config.schema.js";
import * as registration from "./registration.service.js";
import * as access from "./device-access.service.js";

/**
 * /api/v1/device-access — gestão LIMITADA a um dispositivo, por MAC + chave de 6 dígitos mostrada na TV.
 * A sessão daqui NÃO é administrativa: só enxerga/altera o dispositivo da própria chave, e expira em poucos minutos.
 */
const router = Router();
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
router.use(noStore);

router.post(
  "/login", deviceKeyIpLimiter, deviceKeyMacLimiter,
  validate({ body: z.object({ mac: z.string().min(11).max(20), key: z.string().regex(/^\d{6}$/, "A chave tem 6 dígitos.") }) }),
  async (req, res) => res.json(await access.loginWithKey({ ...req.valid.body, ip: req.ip, userAgent: req.get("user-agent") })),
);

router.use(access.requireDeviceScope);

router.get("/me", async (req, res) => res.json(await registration.registeredDeviceById(req.deviceScope.device.id)));

router.post("/configure", validate({ body: configurationSchema }), async (req, res) =>
  res.json(await registration.configureDeviceByAdmin(req.deviceScope.device.id, req.valid.body, access.scopeActor(req))));

router.post("/remove-list", validate({ body: z.object({ reason: z.string().trim().min(3).max(500).optional(), activationId: z.string().uuid().optional() }) }), async (req, res) =>
  res.json(await access.removeListInScope({ device: req.deviceScope.device, actor: access.scopeActor(req), reason: req.valid.body.reason, activationId: req.valid.body.activationId })));

router.post("/logout", async (req, res) => {
  await access.logoutScope(req.deviceScope.session);
  res.status(204).end();
});

export default router;
