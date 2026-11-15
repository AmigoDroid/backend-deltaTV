/** A seleção de provedor do Painel do Parceiro NÃO altera o Pix de licenças de TV. */
export const PORTAL_PAYMENT_GATEWAYS=Object.freeze(['manual','infinitepay','mercadopago']);
export const providerAvailable=(provider,config)=>provider==='manual' ||
  (provider==='infinitepay' && Boolean(config.infinitepayHandle&&config.infinitepayApiKey)) ||
  (provider==='mercadopago' && Boolean(config.mpAccessToken&&config.mpWebhookSecret));
export function verifiedAmountMatches(order, amountCents){
  return Number.isSafeInteger(Number(amountCents))&&Number(amountCents)>=100&&Number(amountCents)===Number(order.total_cents);
}
export function isCheckoutDomain(url){
  try{const u=new URL(url);return u.protocol==='https:' &&
    (/^([a-z0-9-]+\.)*infinitepay\.io$/i.test(u.hostname)||/^(www\.)?mercadopago\.com(\.br)?$/i.test(u.hostname));}
  catch{return false;}
}
export function postgresMigrationError(e){
  const code=e?.parent?.code||e?.original?.code||e?.code;
  return code==='42P01'||code==='42703';
}
