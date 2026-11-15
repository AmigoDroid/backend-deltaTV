import { sequelize } from '../../db/models/index.js';
import { notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { decryptSecret } from '../../shared/crypto.js';
import { env } from '../../config/env.js';
import { select, exec, fail, chooseOrder, deliverPaid, releaseReserve, markReview, GLOBAL_LOCK } from './master-pix.core.js';
import { createInfinitePay } from './gateways/infinitepay.js';
import { buildPixPayload, txidOf } from './gateways/brcode.js';
import { CHECKOUT_TTL_MS, MANUAL_ORDER_TTL_MS } from './gateways/index.js';

export const loadGateway = async (partnerId, provider, t) =>
  (await select(`SELECT * FROM reseller_payment_gateways WHERE partner_id=:id AND provider=:provider`, { id: partnerId, provider }, t))[0];
const isOpen = (o) => ['creating', 'pending'].includes(o?.status);
const touch = async (id) => (await select(`UPDATE reseller_master_pix_orders SET checked_at=now() WHERE id=:id RETURNING *`, { id }))[0];

/** Meios ativos de um vendedor (para a oferta mostrada ao comprador). */
export async function activeMethods(sellerId) {
  return (await select(`SELECT provider FROM reseller_payment_gateways WHERE partner_id=:id AND active=true ORDER BY provider`, { id: sellerId })).map((r) => r.provider);
}

export async function expireOrder(id) {
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    const current = await chooseOrder(id, t, true);
    if (!current || !isOpen(current)) return current;
    return releaseReserve(t, current, 'expired', { note: `Pix Master ${id}: prazo de pagamento encerrado` });
  });
}

/* ---------- Emissão ---------- */
export async function issueInfinitePay(order) {
  const gw = await loadGateway(order.seller_partner_id, 'infinitepay');
  if (!gw?.active) throw fail(409, 'GATEWAY_DISABLED', 'O recebimento por InfinitePay deste vendedor está desativado.');
  // Prazo fixo a partir da criação: reenviar a mesma requisição devolve o mesmo link.
  const expires = new Date(new Date(order.created_at).getTime() + CHECKOUT_TTL_MS);
  if (expires.getTime() <= Date.now() + 120_000) return expireOrder(order.id);
  const client = createInfinitePay({ handle: gw.account_ref, apiKey: gw.access_token_enc ? decryptSecret(gw.access_token_enc) : null });
  const { url } = await client.createLink({
    orderNsu: order.id, amountCents: Number(order.total_cents),
    description: `DeltaTV: ${order.quantity} licença(s) de ${order.months} mês(es)`,
    redirectUrl: `${env.resellerPortalUrl}/?pix_order=${order.id}`,
    webhookUrl: `${env.publicBaseUrl}/api/v1/webhooks/master-pix/infinitepay/${order.seller_partner_id}`,
    validUntil: expires,
  });
  return sequelize.transaction(async (t) => {
    const current = await chooseOrder(order.id, t, true);
    if (!current || !isOpen(current)) return current;
    return (await select(`UPDATE reseller_master_pix_orders SET provider_ref=COALESCE(provider_ref,:ref),status='pending',
      checkout_url=:url,expires_at=:expires,updated_at=now() WHERE id=:id RETURNING *`, { id: order.id, ref: `ip:${order.id}`, url, expires }, t))[0];
  });
}

export async function issueManual(order) {
  const gw = await loadGateway(order.seller_partner_id, 'manual_pix');
  if (!gw?.active) throw fail(409, 'GATEWAY_DISABLED', 'O recebimento por Pix com chave própria deste vendedor está desativado.');
  const payload = buildPixPayload({ key: gw.account_ref, name: gw.receiver_name, city: gw.receiver_city, amountCents: Number(order.total_cents), txid: txidOf(order.id) });
  const expires = new Date(new Date(order.created_at).getTime() + MANUAL_ORDER_TTL_MS);
  return sequelize.transaction(async (t) => {
    const current = await chooseOrder(order.id, t, true);
    if (!current || !isOpen(current)) return current;
    return (await select(`UPDATE reseller_master_pix_orders SET provider_ref=COALESCE(provider_ref,:ref),status='pending',
      qr_code=:payload,expires_at=:expires,updated_at=now() WHERE id=:id RETURNING *`, { id: order.id, ref: `manual:${order.id}`, payload, expires }, t))[0];
  });
}

/* ---------- InfinitePay: confirmação ---------- */
/** Única porta de confirmação da InfinitePay: sempre consulta /payment_check (o webhook e o retorno do navegador NÃO são prova). */
export async function verifyInfinitePayment(order, { transactionNsu, slug }) {
  if (order?.provider !== 'infinitepay') throw notFound('Cobrança InfinitePay');
  if (order.status === 'paid') return order;
  const gw = await loadGateway(order.seller_partner_id, 'infinitepay');
  if (!gw) throw fail(503, 'GATEWAY_CONFIG_MISSING', 'Conta recebedora indisponível para conferência.');
  const client = createInfinitePay({ handle: gw.account_ref, apiKey: gw.access_token_enc ? decryptSecret(gw.access_token_enc) : null });
  const check = await client.paymentCheck({ orderNsu: order.id, transactionNsu, slug });
  if (!check.paid) return order;
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    const current = await chooseOrder(order.id, t, true);
    if (!current || current.status === 'paid' || current.status === 'review') return current;
    if (check.amountCents !== Number(current.total_cents)) {
      return markReview(t, current.id, 'Valor confirmado na InfinitePay diverge do valor da cobrança', { paidAt: new Date() });
    }
    if (!isOpen(current)) {
      // Pagamento tardio em cobrança já expirada/cancelada: a reserva foi devolvida, então não entrega às cegas.
      return markReview(t, current.id, 'Pagamento recebido após o prazo; reserva já liberada. Entregue manualmente ou reembolse', { paidAt: new Date() });
    }
    return deliverPaid(t, current, { paidAt: new Date(), txn: transactionNsu, slug });
  });
}

export async function handleInfinitePayWebhook(sellerId, body) {
  const orderId = String(body?.order_nsu ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return { ignored: true };
  const order = await chooseOrder(orderId);
  if (!order || order.seller_partner_id !== sellerId || order.provider !== 'infinitepay') return { ignored: true };
  const transactionNsu = String(body?.transaction_nsu ?? '').slice(0, 80);
  const slug = String(body?.invoice_slug ?? body?.slug ?? '').slice(0, 80);
  if (!transactionNsu || !slug) return { ignored: true };
  await verifyInfinitePayment(order, { transactionNsu, slug });
  return { accepted: true };
}

export async function confirmInfinitePayReturn(buyerId, orderId, { transactionNsu, slug }) {
  const order = await chooseOrder(orderId);
  if (!order || order.buyer_partner_id !== buyerId) throw notFound('Cobrança Pix da sua revenda');
  return verifyInfinitePayment(order, { transactionNsu, slug });
}

/* ---------- Pix com chave própria (confirmação do vendedor) ---------- */
const ownedManual = async (t, id, column, partnerId) => {
  const order = await chooseOrder(id, t, true);
  if (!order || order[column] !== partnerId || order.provider !== 'manual_pix') throw notFound('Cobrança Pix');
  return order;
};
export async function claimPaid(buyerId, orderId, actor) {
  return sequelize.transaction(async (t) => {
    const order = await ownedManual(t, orderId, 'buyer_partner_id', buyerId);
    if (order.status !== 'pending') throw fail(409, 'ORDER_NOT_OPEN', 'Esta cobrança não está mais aguardando pagamento.');
    if (order.payer_claimed_at) return order;
    await audit({ actor, action: 'distribution.pix.order.claimed', entityType: 'partner', entityId: buyerId, metadata: { orderId }, transaction: t });
    return (await select(`UPDATE reseller_master_pix_orders SET payer_claimed_at=now(),updated_at=now() WHERE id=:id RETURNING *`, { id: orderId }, t))[0];
  });
}
export async function cancelByBuyer(buyerId, orderId, actor) {
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    const order = await ownedManual(t, orderId, 'buyer_partner_id', buyerId);
    if (order.status !== 'pending' || order.payer_claimed_at) throw fail(409, 'ORDER_NOT_CANCELLABLE', 'Depois de informar o pagamento, só o vendedor pode recusar ou confirmar.');
    await audit({ actor, action: 'distribution.pix.order.cancelled', entityType: 'partner', entityId: buyerId, metadata: { orderId, by: 'buyer' }, transaction: t });
    return releaseReserve(t, order, 'cancelled');
  });
}
export async function sellerConfirm(sellerId, orderId, actor) {
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    const order = await ownedManual(t, orderId, 'seller_partner_id', sellerId);
    if (order.status === 'paid') return order;
    if (order.status !== 'pending') throw fail(409, 'ORDER_NOT_OPEN', 'Esta cobrança não está aguardando confirmação.');
    return deliverPaid(t, order, { paidAt: new Date(), actor, confirmedBy: actor?.id ?? null, via: 'seller' });
  });
}
export async function sellerReject(sellerId, orderId, actor) {
  return sequelize.transaction(async (t) => {
    await exec(GLOBAL_LOCK, {}, t);
    const order = await ownedManual(t, orderId, 'seller_partner_id', sellerId);
    if (order.status !== 'pending') throw fail(409, 'ORDER_NOT_OPEN', 'Esta cobrança não está aguardando confirmação.');
    await audit({ actor, action: 'distribution.pix.order.rejected', entityType: 'partner', entityId: order.buyer_partner_id, metadata: { orderId, sellerId }, transaction: t });
    return releaseReserve(t, order, 'cancelled', { note: `Pix Master ${orderId}: recusado pelo vendedor` });
  });
}

/* ---------- Conciliação periódica (job) ---------- */
export async function reconcileGatewayOrder(order) {
  if (isOpen(order)) {
    const claimed = order.provider === 'manual_pix' && order.payer_claimed_at;
    // InfinitePay: sem transaction_nsu/slug não há como consultar; aguarda o prazo + folga e trata pagamento tardio como "em conferência".
    const grace = order.provider === 'infinitepay' ? 15 * 60_000 : 0;
    if (!claimed && order.expires_at && new Date(order.expires_at).getTime() + grace < Date.now()) return expireOrder(order.id);
  }
  return touch(order.id);
}
