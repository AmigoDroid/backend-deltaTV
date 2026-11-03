import { Router } from "express";
import { z } from "zod";
import { sequelize, WebhookEvent } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { hmacHex, safeEqualHex } from "../../shared/crypto.js";
import { webhookLimiter } from "../../middleware/security.js";
import { confirmPaymentTx } from "./billing.service.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";

/**
 * Adaptadores por provedor. "generic" usa HMAC-SHA256 sobre `${timestamp}.${corpo bruto}`.
 * Para Mercado Pago / Asaas / Stripe: adicione uma entrada aqui com o `verify` do provedor
 * (cada um assina de forma diferente) e um `parse` que normalize o evento para o formato abaixo.
 */
const eventSchema = z.object({
  eventId: z.string().min(1).max(120),
  type: z.literal("payment.confirmed"),
  invoiceId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  providerRef: z.string().min(1).max(120),
  method: z.string().max(30).optional(),
});

const PROVIDERS = {
  generic: {
    verify(req) {
      const ts = req.get("x-webhook-timestamp");
      const sig = req.get("x-webhook-signature");
      if (!ts || !sig || !req.rawBody) return false;
      if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false; // anti-replay
      return safeEqualHex(hmacHex(env.webhookSecret, `${ts}.${req.rawBody.toString("utf8")}`), sig);
    },
    parse: (body) => eventSchema.parse(body),
  },
};

const router = Router();

router.post("/:provider", webhookLimiter, async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider) throw new AppError(404, "NOT_FOUND", "Provedor desconhecido.");
  if (!provider.verify(req)) throw new AppError(401, "INVALID_SIGNATURE", "Assinatura inválida.");
  const event = provider.parse(req.body);

  try {
    const result = await sequelize.transaction(async transaction => {
      const [row] = await WebhookEvent.findOrCreate({
        where: { provider: req.params.provider, eventId: event.eventId },
        defaults: { provider: req.params.provider, eventId: event.eventId, payload: event },
        transaction,
      });
      await row.reload({ transaction, lock: transaction.LOCK.UPDATE });
      if (row.status === "processed") return { duplicate: true };
      // O evento e o pagamento são confirmados juntos. Uma falha temporária faz
      // rollback e permite que a reentrega do provedor processe o pagamento.
      const payment = await confirmPaymentTx(transaction, event.invoiceId,
        { amountCents: event.amountCents, method: event.method, provider: req.params.provider, providerRef: event.providerRef, origin: "webhook" },
        { type: "webhook", id: req.params.provider, ip: req.ip });
      await row.update({ status: "processed", processedAt: new Date(), error: null }, { transaction });
      return { reactivated: payment.reactivated };
    });
    if (result.reactivated) clearMirrorAuth();
    res.json({ ok: true, ...(result.duplicate ? { duplicate: true } : {}) });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) return res.json({ ok: false, code: error.code });
    throw error;
  }
});

export default router;
