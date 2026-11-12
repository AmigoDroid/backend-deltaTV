import { legacyPoll, noteDeviceLatency, noteDeviceTransport } from "../../realtime/device-channel.js";
import { requestDeviceFailover } from '../provider-monitor/device-failover.service.js';
import { claimRemoteCommands, acknowledgeRemoteCommand } from '../../realtime/remote-control.service.js';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { AppError } from '../../shared/errors.js';
import { telemetryValidate, telemetry, requireTelemetry } from '../connection-audit/routes.js';
import { Router } from "express";
import { requireDevice } from "../access/access.middleware.js";
import { heartbeatLimiter } from "../../middleware/security.js";
import { env } from "../../config/env.js";
import { noticeForActivation } from '../clients/expiry-notice.service.js';

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
router.post("/connection", heartbeatLimiter, requireTelemetry, telemetryValidate, telemetry);
// Pseudo-WebSocket HTTPS para Roku legado: nunca usar ws:// sem TLS.
router.get("/realtime/poll", heartbeatLimiter, legacyPoll);
// As rotas legadas acima permanecem. Novos comandos sempre exigem token de telemetria ativo.
router.get('/realtime/commands', heartbeatLimiter, requireTelemetry, async (req, res) =>
  res.set('Cache-Control','no-store').json({ ok: true, commands: await claimRemoteCommands(req.device.activation.id, req.get('x-deltatv-transport') || 'https') }));
router.post('/realtime/commands/:id/ack', heartbeatLimiter, requireTelemetry,
  validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ status: z.enum(['executed','failed','refused']), errorCode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), errorcode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), result: z.object({rttMs:z.number().int().min(0).max(30000).optional(),networkUp:z.boolean().optional(),osMajor:z.number().int().min(0).max(100).optional(),transport:z.enum(['wss','https-legacy']).optional(),failoverAccepted:z.boolean().optional(),originRttMs:z.number().int().min(0).max(30000).optional(),originHttpStatus:z.number().int().min(100).max(599).optional()}).strict().optional() }).strict() }),
  async (req, res) => res.set('Cache-Control','no-store').json(await acknowledgeRemoteCommand({
    id: req.valid.params.id, activationId: req.device.activation.id,
    status: req.valid.body.status, errorCode: req.valid.body.errorCode || req.valid.body.errorcode, result: req.valid.body.result,
  })));
router.post('/realtime/failover', heartbeatLimiter, requireTelemetry, async (req,res) =>
  res.set('Cache-Control','no-store').json(await requestDeviceFailover(req.device.activation.id)));
// Somente a ativação da sessão válida pode obter o aviso; nunca recebe dados de outras TVs.
router.get('/realtime/expiry-notice', heartbeatLimiter, requireTelemetry, async(req,res) =>
  res.set('Cache-Control','no-store').json(await noticeForActivation(req.device.activation.id)));
router.get('/realtime/ping', heartbeatLimiter, requireTelemetry, (_req,res) =>
  res.set('Cache-Control','no-store').json({ ok: true }));
router.post('/realtime/latency', heartbeatLimiter, requireTelemetry,
  validate({ body: z.object({ rttMs: z.number().int().min(0).max(30000).optional(), rttms: z.number().int().min(0).max(30000).optional(), build: z.string().max(16).optional() }).strict().refine(x => x.rttMs !== undefined || x.rttms !== undefined) }),
  (req, res) => {
    noteDeviceTransport(req.device.activation.id,'https-legacy',req.valid.body.build);
    noteDeviceLatency(req.device.activation.id,req.valid.body.rttMs ?? req.valid.body.rttms);
    res.set('Cache-Control','no-store').json({ ok: true });
  });
export default router;
