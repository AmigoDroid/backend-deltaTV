import { createMercadoPago } from '../pix/providers/mercadopago.js';
import { createInfinitePay } from '../distribution/gateways/infinitepay.js';
import { verifyNetworkPaymentMatch } from './policy.js';
import { requiredSettlementCents } from './charge-pricing.js';

/**
 * Read-only reconciliation. Never POST /links or /payments.
 * MP: authenticated GET search by external_reference then GET by payment id.
 * InfinitePay: authenticated POST /payment_check (a read-only status operation),
 * which REQUIRES transaction_nsu and slug; order_nsu alone cannot be queried.
 * Returns no credentials, bank details or complete Pix payload.
 */
export async function inspectCreatingCharge(charge, gateway, {
  now=new Date(), mercadopago=createMercadoPago, infinitepay=createInfinitePay,
}={}) {
  if (!charge || charge.method!=='automatic' || charge.status!=='creating')
    return {kind:'incomplete',reason:'NOT_CREATING_AUTOMATIC'};
  if (!gateway?.credential) return {kind:'incomplete',reason:'GATEWAY_CREDENTIAL_MISSING'};
  let receipt, reference=null, qrCode=null, transactionNsu=null, slug=null;
  const expectedAccount=String(gateway.accountRef||'');
  if (charge.provider==='mercadopago') {
    const api=mercadopago({accessToken:gateway.credential});
    let id=charge.provider_ref;
    if (!id) {
      const match=await api.searchByExternalReference(charge.id);
      if (match.total>1 || match.ids.length>1) return {kind:'review',reason:'MULTIPLE_PROVIDER_PAYMENTS'};
      if (!match.ids.length) return {kind:'missing'};
      id=match.ids[0];
    }
    const payment=await api.getPayment(id);
    if (!payment || payment.externalReference!==charge.id || String(payment.providerRef)!==String(id))
      return {kind:'review',reason:'PROVIDER_REFERENCE_MISMATCH'};
    reference=String(id);
    if (payment.status==='pending') {
      if (payment.paymentMethod && payment.paymentMethod!=='pix') return {kind:'review',reason:'NON_PIX_PAYMENT'};
      if (String(payment.collectorId||'')!==expectedAccount || payment.currency!=='BRL'
          || payment.amountCents!==Number(charge.amount_cents))
        return {kind:'review',reason:'PENDING_PAYMENT_MISMATCH'};
      qrCode=payment.qrCode||null;
      return {kind:'pending',providerRef:reference,qrCode};
    }
    if (payment.status!=='paid') return {kind:'review',reason:'PROVIDER_PAYMENT_NOT_PAYABLE'};
    receipt={confirmed:true,externalReference:payment.externalReference,providerRef:reference,
      currency:payment.currency,paymentMethod:payment.paymentMethod,
      collectorId:payment.collectorId,amountCents:payment.amountCents};
  } else if (charge.provider==='infinitepay') {
    transactionNsu=charge.transaction_nsu;
    slug=charge.payment_slug;
    // Official API explicitly requires BOTH; no undocumented search by order_nsu.
    if (!transactionNsu || !slug) return {kind:'incomplete',reason:'INFINITEPAY_IDENTIFIERS_MISSING'};
    const payment=await infinitepay({handle:expectedAccount,apiKey:gateway.credential})
      .paymentCheck({orderNsu:charge.id,transactionNsu,slug});
    if (!payment.paid) return {kind:'missing'};
    receipt={confirmed:true,externalReference:charge.id,providerRef:charge.provider_ref,
      currency:'BRL',paymentMethod:String(payment.captureMethod||'').toLowerCase(),
      collectorId:expectedAccount,amountCents:payment.paidAmountCents??payment.amountCents};
  } else return {kind:'review',reason:'UNKNOWN_PROVIDER'};
  const amountDue=new Date(charge.expires_at)<now
    ?requiredSettlementCents(charge.breakdown,now,Number(charge.amount_cents))
    :Number(charge.amount_cents);
  const match=verifyNetworkPaymentMatch({...charge,amount_cents:amountDue},receipt,expectedAccount);
  if (!match) return {kind:'review',reason:'PAYMENT_MISMATCH',receivedCents:receipt.amountCents??null};
  return {kind:'paid',providerRef:reference,transactionNsu,slug,amountCents:receipt.amountCents};
}
