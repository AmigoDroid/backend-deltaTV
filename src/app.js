import express from "express";
import { broadcastChange } from "./realtime/socket.js";
import { invalidateDashboardCache } from "./modules/dashboard/dashboard.routes.js";
import helmet from "helmet";
import cors from "cors";
import { env } from "./config/env.js";
import { AppError, errorHandler } from "./shared/errors.js";
import { requestContext, apiLimiter, mirrorLimiter } from "./middleware/security.js";
import { publicRouter as whiteLabelPublic } from "./modules/white-label/white-label.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import contentPartnerRoutes from "./modules/provider-monitor/monitor.routes.js";
import adminRoutes from "./modules/admin.routes.js";
import clientRoutes from "./modules/activations/client.routes.js";
import portalRoutes from "./modules/portal/portal.routes.js";
import webhookRoutes from "./modules/billing/webhook.routes.js";
import { webhookRouter as pixWebhookRoutes } from "./modules/pix/pix.routes.js";
import pairingRoutes from "./modules/devices/pairing.routes.js";
import deviceAccessRoutes from "./modules/devices/device-access.routes.js";
import playRoutes from "./modules/sources/delivery.routes.js";
import mirrorRoutes from "./modules/mirror/mirror.routes.js";
import heartbeatRoutes from "./modules/devices/presence.routes.js";
import { publicRouter as appDownloadFiles } from "./modules/downloads/download.routes.js";

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
      methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"],
      exposedHeaders: ["Content-Range", "Accept-Ranges", "Content-Length"],
      allowedHeaders: ["Content-Type", "Authorization", "Range", "X-Webhook-Signature", "X-Webhook-Timestamp"],
    }),
  );
  // rawBody é necessário para validar a assinatura HMAC dos webhooks.
  app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Reprodução (gateway /api/v1/play e rota espelho Xtream): ficam ANTES do limitador global — playlists HLS fazem
  // requisições contínuas e várias TVs compartilham o mesmo IP. Cada uma tem o seu limitador por credencial.
  app.use("/api/v1/play", mirrorLimiter, playRoutes);
  app.use(mirrorRoutes);
  // Heartbeat de presença: também antes do limitador global (várias TVs no mesmo IP); tem o seu limitador por token.
  app.use("/api/v1/client/heartbeat", heartbeatRoutes);

  // Arquivos (APK) hospedados na VPS: público, sem login; as TVs/aparelhos dos clientes baixam daqui.
  app.use("/dl", appDownloadFiles);

  // Sessões de players white-label têm limite próprio por token (não por IP público compartilhado).
  app.use("/api/v1/player-apps", whiteLabelPublic);
  app.use(apiLimiter);
  // Notificar após respostas bem-sucedidas; o convite público também cria uma parceria.
  app.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
    const completesPartnerInvite = req.method === "POST" && req.path === "/api/v1/auth/partner-invite/complete";
    if (!completesPartnerInvite && !/^\/api\/v1\/(admin|partner|content-partner)\//.test(req.path)) return next();
    res.on("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300 && (req.user || completesPartnerInvite)) {
        const isPartner = req.user?.role === "partner";
        const segments = req.path.split("/").filter(Boolean);
        const area = completesPartnerInvite ? "partners" : segments[3] || "data";  // /api/v1/admin/devices => devices
        const topic = area === "app-downloads" ? "downloads" : area;
        // Em operações administrativas, apenas administradores recebem atualização global.
        // Parceiros só recebem eventos associados ao seu próprio cadastro.
        const modifiedPartner = !isPartner && area === "partners" &&
          /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segments[4] || "") ? segments[4] : null;
        invalidateDashboardCache();
        broadcastChange({ partnerId: isPartner ? req.user.partnerId : modifiedPartner, topic });
      }
    });
    next();
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/pair", pairingRoutes);

  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/content-partner", contentPartnerRoutes);
  app.use("/api/v1/admin", adminRoutes);
  app.use("/api/v1/partner", portalRoutes);
  app.use("/api/v1/client", clientRoutes);
  app.use("/api/v1/device-access", deviceAccessRoutes);
  app.use("/api/v1/webhooks/payments", webhookRoutes);
  app.use("/api/v1/webhooks/pix", pixWebhookRoutes);

  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Rota não encontrada.")));
  app.use(errorHandler);
  return app;
}
