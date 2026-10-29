import { Router } from "express";
import { requireDevice } from "../access/access.middleware.js";
import { heartbeatLimiter } from "../../middleware/security.js";
import { env } from "../../config/env.js";

/**
 * POST /api/v1/client/heartbeat — "estou vivo".
 * Header: Authorization: Bearer <accessToken do aparelho>. Sem corpo.
 * O sinal de vida é registrado pelo requireDevice (mesmo gatilho de qualquer chamada autenticada); aqui só respondemos.
 * enforce:false → aparelho bloqueado/expirado também responde 200 (continua "online" e o app decide a UI por /status).
 * Token de acesso vencido → 401, e o app renova pelo /session/refresh como em qualquer outra chamada.
 */
const router = Router();
router.post("/", heartbeatLimiter, requireDevice("device", { enforce: false }), (_req, res) => {
  res.set("Cache-Control", "no-store").json({
    ok: true,
    intervalSeconds: env.presenceHeartbeatSeconds, // o servidor dita o ritmo; o app só obedece
    serverTime: new Date().toISOString(),
  });
});
export default router;
