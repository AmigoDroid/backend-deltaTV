import { createHash } from 'node:crypto';

export const PROVIDERS = Object.freeze(['mercadopago','infinitepay']);
export const CHARGE_STATUSES = Object.freeze(['creating','pending','paid','expired','cancelled','failed','review','needs_review']);
export const CHARGE_KINDS = Object.freeze(['renewal','upgrade','one_off']);
export const maskAccountRef = value => {
  const str = String(value || '');
  return str ? (str.length <= 4 ? '*'.repeat(str.length) : `${'*'.repeat(Math.min(8, Math.max(4,str.length-4)))}${str.slice(-4)}`) : null;
};
export const fingerprint = ({provider,credential,secret='',accountRef}) => createHash('sha256')
  .update(JSON.stringify([provider,credential,secret,accountRef])).digest('hex');
export const canActivateGateway = row => Boolean(row && row.tested_fingerprint === row.credential_fingerprint &&
  row.tested_at && (Date.now() - new Date(row.tested_at).getTime() < 24 * 3600_000));
export const isSettled = status => ['paid','cancelled','expired','failed','review','needs_review'].includes(status);
export function csvSafe(value) {
  const data = String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  // Protege abertura no Excel/LibreOffice contra fórmula injetada por nome/referência.
  const safe = /^[\s]*[=+@-]/.test(data) ? `'${data}` : data;
  return `"${safe.replaceAll('"','""')}"`;
}

/** Comprovante do provedor: permite sobrepagamento, não permite subpagamento ou troca de recebedor. */
export function verifyNetworkPaymentMatch(charge, receipt, expectedAccount){
  return Boolean(charge && receipt && receipt.confirmed===true &&
    receipt.externalReference===charge.id &&
    (!charge.provider_ref || String(receipt.providerRef)===String(charge.provider_ref)) &&
    receipt.currency==='BRL' && receipt.paymentMethod==='pix' &&
    Number.isSafeInteger(receipt.amountCents) && receipt.amountCents>=Number(charge.amount_cents) &&
    String(receipt.collectorId||'')===String(expectedAccount||''));
}
