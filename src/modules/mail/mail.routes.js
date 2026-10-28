import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { mailSendLimiter } from "../../middleware/security.js";
import { AUDIENCES } from "./mail.recipients.js";
import * as svc from "./mail.service.js";

/**
 * E-mails em massa do painel (/api/v1/admin/mail). Permissão "mail:send": hoje só o superadmin ("*") a tem.
 * Enviar não é síncrono: a mensagem entra na fila e o worker envia no ritmo configurado; o histórico mostra o andamento.
 */
const router = Router();
router.use(requirePermission("mail:send"));
const id = z.object({ id: z.string().uuid() });

const audienceShape = {
  audience: z.enum(AUDIENCES),
  partnerId: z.string().uuid().optional(),
  emails: z.array(z.string().trim().max(200)).max(500).optional(),
};
const needsFields = (b, ctx) => {
  if (b.audience === "partner" && !b.partnerId) ctx.addIssue({ code: "custom", path: ["partnerId"], message: "Escolha a revenda." });
  if (b.audience === "custom" && !b.emails?.length) ctx.addIssue({ code: "custom", path: ["emails"], message: "Informe ao menos um e-mail." });
};

router.get("/status", async (_req, res) => res.json(await svc.status()));

router.post("/test", mailSendLimiter, async (req, res) =>
  res.json(await svc.sendTest({ to: req.user.email, name: req.user.name })));

router.post("/preview", validate({ body: z.object(audienceShape).superRefine(needsFields) }), async (req, res) =>
  res.json(await svc.previewAudience(req.valid.body)));

router.post("/messages", mailSendLimiter,
  validate({ body: z.object({ ...audienceShape, subject: z.string().trim().min(3).max(200), body: z.string().min(1).max(20000) }).superRefine(needsFields) }),
  async (req, res) => res.status(201).json(await svc.createMessage(req.valid.body, actorOf(req))));

router.get("/messages", validate({ query: z.object(pageQuery) }), async (req, res) => res.json(await svc.listMessages(req.valid.query)));
router.get("/messages/:id", validate({ params: id, query: z.object({ ...pageQuery, status: z.enum(["pending", "sending", "sent", "failed", "cancelled"]).optional() }) }), async (req, res) =>
  res.json(await svc.getMessage(req.valid.params.id, req.valid.query)));
router.post("/messages/:id/retry", validate({ params: id }), async (req, res) => res.json(await svc.retryFailed(req.valid.params.id, actorOf(req))));
router.post("/messages/:id/cancel", validate({ params: id }), async (req, res) => res.json(await svc.cancelPending(req.valid.params.id, actorOf(req))));

export default router;
