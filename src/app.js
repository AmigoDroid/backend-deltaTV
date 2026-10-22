import express from "express";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.js";
import { AppError, errorHandler } from "./shared/errors.js";
import { requestContext, apiLimiter, mirrorLimiter } from "./middleware/security.js";
import authRoutes from "./modules/auth/auth.routes.js";
import adminRoutes from "./modules/admin.routes.js";
import clientRoutes from "./modules/activations/client.routes.js";
import portalRoutes from "./modules/portal/portal.routes.js";
import webhookRoutes from "./modules/billing/webhook.routes.js";
import pairingRoutes from "./modules/devices/pairing.routes.js";
import deviceAccessRoutes from "./modules/devices/device-access.routes.js";
import playRoutes from "./modules/sources/delivery.routes.js";
import mirrorRoutes from "./modules/mirror/mirror.routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.trustProxy);
  app.use(requestContext);
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin(origin, cb) {
        // Sem Origin (apps nativos, curl, players) é permitido; navegadores só nas origens configuradas.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(new AppError(403, "CORS_NOT_ALLOWED", "Origem não permitida."));
      },
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Webhook-Signature", "X-Webhook-Timestamp"],
    }),
  );
  // rawBody é necessário para validar a assinatura HMAC dos webhooks.
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Reprodução (gateway /api/v1/play e rota espelho Xtream): ficam ANTES do limitador global — playlists HLS fazem
  // requisições contínuas e várias TVs compartilham o mesmo IP. Cada uma tem o seu limitador por credencial.
  app.use("/api/v1/play", mirrorLimiter, playRoutes);
  app.use(mirrorRoutes);

  app.use(apiLimiter);

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/pair", pairingRoutes);

  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/admin", adminRoutes);
  app.use("/api/v1/partner", portalRoutes);
  app.use("/api/v1/client", clientRoutes);
  app.use("/api/v1/device-access", deviceAccessRoutes);
  app.use("/api/v1/webhooks/payments", webhookRoutes);

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Rota não encontrada.")));
  app.use(errorHandler);
  return app;
}
