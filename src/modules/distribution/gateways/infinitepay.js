import { AppError } from '../../../shared/errors.js';
import { toMpDate } from '../../pix/providers/mercadopago.js';

/**
 * Adaptador do Checkout Integrado da InfinitePay (link hospedado).
 * - POST /links cria o link; o comprador paga na página da InfinitePay (Pix ou cartão) e volta por redirect_url.
 * - POST /payment_check confirma o pagamento (handle + order_nsu + transaction_nsu + slug).
 * O webhook NÃO tem assinatura: só o /payment_check prova pagamento. A API Key (opcional) só viaja no cabeçalho X-Api-Key.
 */
const BASE = 'https://api.checkout.infinitepay.io';
export const HANDLE_RE = /^[A-Za-z0-9._-]{2,40}$/;
export const normalizeHandle = (raw) => String(raw ?? '').trim().replace(/^\$/, '');

export function pickLinkUrl(data) {
  const url = data?.url ?? data?.link ?? data?.checkout_url ?? data?.payment_url ?? data?.data?.url ?? null;
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'https:' && /(^|\.)infinitepay\.io$/i.test(parsed.hostname) ? parsed.toString() : null;
  } catch { return null; }
}

export function createInfinitePay({ handle, apiKey = null, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  async function post(path, body) {
    let res;
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      console.error(`[pix] InfinitePay ${path}: falha de rede (${e.name})`);
      throw new AppError(502, 'PIX_PROVIDER_UNAVAILABLE', 'Não foi possível falar com a InfinitePay agora. Tente novamente em instantes.');
    }
    const data = await res.json().catch(() => null);
    return { res, data };
  }
  return {
    async createLink({ orderNsu, amountCents, description, redirectUrl, webhookUrl, validUntil }) {
      const body = {
        handle, order_nsu: orderNsu, redirect_url: redirectUrl, webhook_url: webhookUrl,
        items: [{ quantity: 1, price: amountCents, description: String(description).slice(0, 120) }],
        ...(apiKey && validUntil ? { options: { valid_until: toMpDate(validUntil) } } : {}),
      };
      const { res, data } = await post('/links', body);
      if (!res.ok) {
        console.error(`[pix] InfinitePay /links -> ${res.status} ${String(data?.message ?? '').slice(0, 160)}`);
        if (res.status === 403) throw new AppError(422, 'INFINITEPAY_FORBIDDEN', 'A InfinitePay recusou a chave informada para esta conta (handle e API Key de contas diferentes).');
        throw new AppError(422, 'INFINITEPAY_REJECTED', 'A InfinitePay não criou o link. Confira se o Checkout Integrado está ativado na conta do vendedor e se o handle está correto.');
      }
      const url = pickLinkUrl(data);
      if (!url) throw new AppError(502, 'INFINITEPAY_BAD_RESPONSE', 'Resposta inesperada da InfinitePay ao criar o link.');
      return { url };
    },
    /** paid só é true quando success e paid vêm verdadeiros. Qualquer outra resposta = não pago (sem erro). */
    async paymentCheck({ orderNsu, transactionNsu, slug }) {
      const { res, data } = await post('/payment_check', { handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug });
      if (res.status >= 500) throw new AppError(502, 'PIX_PROVIDER_UNAVAILABLE', 'A InfinitePay não respondeu à conferência do pagamento.');
      const ok = res.ok && data?.success === true && data?.paid === true;
      return {
        paid: ok, amountCents: Number.isFinite(Number(data?.amount)) ? Number(data.amount) : null,
        paidAmountCents: Number.isFinite(Number(data?.paid_amount)) ? Number(data.paid_amount) : null,
        captureMethod: data?.capture_method ?? null,
      };
    },
  };
}
