import crypto from "node:crypto";
import { AppError } from "../../../shared/errors.js";

/**
 * Adaptador do Mercado Pago (API de Pagamentos, payment_method_id "pix").
 *
 * Contrato comum dos provedores (ver providers/index.js):
 *   createCharge({ id, amountCents, description, payer, expiresAt, notificationUrl }) -> { providerRef, qrCode, qrCodeBase64, ticketUrl, expiresAt }
 *   getPayment(providerRef) -> { providerRef, status: "paid"|"pending"|"cancelled"|"refunded", amountCents, externalReference, paidAt }
 *   verifyWebhook(req) / paymentIdFromWebhook(req)
 *
 * `fetchImpl` é injetável para testes. O token só viaja no cabeçalho Authorization e nunca é registrado em log.
 */
const BASE = "https://api.mercadopago.com";

// Brasil: UTC-3 fixo desde 2019. O Mercado Pago pede a data com o deslocamento ("2026-10-26T16:30:00.000-03:00").
export const toMpDate = (date) => new Date(new Date(date).getTime() - 3 * 3600_000).toISOString().replace("Z", "-03:00");

export const centsToAmount = (cents) => Number((cents / 100).toFixed(2));
export const amountToCents = (amount) => Math.round(Number(amount) * 100);

/** approved => paid; refunded/charged_back => refunded; cancelled/rejected => cancelled; o resto aguarda. */
export function mapStatus(status) {
  switch (status) {
    case "approved": return "paid";
    case "refunded":
    case "charged_back": return "refunded";
    case "cancelled":
    case "rejected": return "cancelled";
    default: return "pending"; // pending, in_process, authorized, in_mediation
  }
}

/**
 * Valida o cabeçalho x-signature ("ts=...,v1=<hmac>") do Mercado Pago.
 * Manifesto assinado: `id:<data.id em minúsculas>;request-id:<x-request-id>;ts:<ts>;` (partes ausentes são omitidas).
 */
export function verifySignature({ secret, signatureHeader, requestId, dataId }) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    String(signatureHeader).split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  if (!parts.ts || !/^[0-9a-f]{64}$/i.test(parts.v1 ?? "")) return false;
  let manifest = "";
  if (dataId) manifest += `id:${/^[A-Za-z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : dataId};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac("sha256", secret).update(manifest).digest();
  const got = Buffer.from(parts.v1, "hex");
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/** id do pagamento como veio na notificação (query `data.id`, ou corpo). É ele que entra no manifesto assinado. */
const rawDataId = (req) => req.query?.["data.id"] ?? req.query?.data?.id ?? req.body?.data?.id ?? null;

export function createMercadoPago({ accessToken, webhookSecret = "", fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  async function call(path, { method = "GET", body, idempotencyKey } = {}) {
    let res;
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
          ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error(`[pix] Mercado Pago ${method} ${path.split("?")[0]}: falha de rede (${e.name})`);
      throw new AppError(502, "PIX_PROVIDER_UNAVAILABLE", "Não foi possível falar com o provedor de Pix agora. Tente novamente em instantes.");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // Só status e mensagem do provedor (nunca cabeçalhos nem token).
      console.error(`[pix] Mercado Pago ${method} ${path.split("?")[0]} -> ${res.status} ${String(data?.message ?? data?.error ?? "").slice(0, 200)}`);
      if (res.status === 404) throw new AppError(404, "PIX_PAYMENT_NOT_FOUND", "Pagamento não encontrado no provedor.");
      throw new AppError(502, "PIX_PROVIDER_ERROR", "O provedor de Pix recusou a operação. Tente novamente em instantes.");
    }
    return data;
  }

  return {
    name: "mercadopago",

    async createCharge({ id, amountCents, description, payer, expiresAt, notificationUrl }) {
      const body = {
        transaction_amount: centsToAmount(amountCents),
        description: String(description).slice(0, 200),
        payment_method_id: "pix",
        date_of_expiration: toMpDate(expiresAt),
        external_reference: id,
        payer: { email: payer.email, ...(payer.name ? { first_name: String(payer.name).slice(0, 60) } : {}) },
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
      };
      const p = await call("/v1/payments", { method: "POST", body, idempotencyKey: id });
      const tx = p?.point_of_interaction?.transaction_data;
      if (!p?.id || !tx?.qr_code) {
        console.error("[pix] Mercado Pago respondeu sem QR Code (a conta tem Pix habilitado e chave Pix cadastrada?)");
        throw new AppError(502, "PIX_PROVIDER_ERROR", "O provedor de Pix não devolveu o QR Code. Fale com a plataforma.");
      }
      return {
        providerRef: String(p.id), qrCode: tx.qr_code, qrCodeBase64: tx.qr_code_base64 ?? null, ticketUrl: tx.ticket_url ?? null,
        expiresAt: p.date_of_expiration ? new Date(p.date_of_expiration) : expiresAt,
      };
    },

    async getPayment(providerRef) {
      if (!/^\d{1,20}$/.test(String(providerRef))) throw new AppError(422, "PIX_INVALID_REF", "Identificador de pagamento inválido.");
      const p = await call(`/v1/payments/${providerRef}`);
      if (p.payment_method_id && p.payment_method_id !== "pix") {
        throw new AppError(422, "PIX_NOT_PIX", "O pagamento informado não é um Pix.");
      }
      return {
        providerRef: String(p.id), status: mapStatus(p.status), rawStatus: p.status,
        amountCents: amountToCents(p.transaction_amount), externalReference: p.external_reference ?? null,
        paidAt: p.date_approved ? new Date(p.date_approved) : null,
      };
    },

    /** Notificação autêntica? Sem segredo configurado aceita (o pagamento é sempre reconsultado na API do provedor). */
    verifyWebhook(req) {
      if (!webhookSecret) return true;
      return verifySignature({
        secret: webhookSecret, signatureHeader: req.get("x-signature"), requestId: req.get("x-request-id"),
        dataId: rawDataId(req),
      });
    },

    /** Só notificações de pagamento interessam; devolve o id do pagamento ou null. */
    paymentIdFromWebhook(req) {
      const type = req.query?.type ?? req.query?.topic ?? req.body?.type ?? req.body?.topic;
      if (type && type !== "payment") return null;
      const id = rawDataId(req) ?? req.query?.id;
      return id != null && /^\d{1,20}$/.test(String(id)) ? String(id) : null;
    },
  };
}
