/** Regras testáveis independentemente do banco e do provedor. Centavos inteiros. */
export const BRL_CENTS_MAX = 9_000_000_000_000; // limite técnico de precisão, NÃO uma quota comercial
export function totalCents(unitCents, quantity) {
  if (!Number.isSafeInteger(unitCents) || unitCents < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2_147_483_647) return null;
  const total = unitCents * quantity;
  return Number.isSafeInteger(total) && total <= BRL_CENTS_MAX ? total : null;
}
export function verifyPaymentMatch(order, payment, merchantId) {
  return !!order?.provider_ref && payment?.providerRef != null && String(payment.providerRef) === String(order.provider_ref)
    && payment?.externalReference === order.id && payment?.amountCents === Number(order.total_cents)
    && payment.paymentMethod === 'pix' && payment.currency === 'BRL'
    && !!payment.collectorId && String(payment.collectorId) === String(merchantId);
}
export function canDeliver(order, buyer, seller) {
  return order.status !== 'paid' && !order.fulfilled_at && !order.released_at
    && buyer?.status === 'active' && buyer?.parentPartnerId === seller?.id
    && seller?.status === 'active' && seller?.distributionRole === 'master';
}
export function isSettled(status) { return ['paid','expired','cancelled','refunded'].includes(status); }
export function reserveCanRelease(status) { return status === 'cancelled' || status === 'refunded'; }
