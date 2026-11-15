/** Cobranças feitas por Masters para vender SOMENTE o acesso ao Painel do Parceiro.
 * Nunca usa credenciais globais da DeltaTV. O estoque já fica reservado pelo convite.
 * Webhooks não são prova de pagamento: sempre consultar o provedor individual.
 */
import {QueryTypes} from 'sequelize';
import {sequelize,AdminUser} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {decryptSecret,verifyPassword} from '../../shared/crypto.js';
import {env} from '../../config/env.js';
import {createInfinitePay} from '../distribution/gateways/infinitepay.js';
import {createMercadoPago} from '../pix/providers/mercadopago.js';
const err=(status,code,message)=>{throw new AppError(status,code,message);};
const read=(sql,p={},t)=>sequelize.query(sql,{replacements:p,type:QueryTypes.SELECT,transaction:t});
const run=(sql,p={},t)=>sequelize.query(sql,{replacements:p,transaction:t});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;
const tx=fn=>sequelize.transaction(async t=>{await run('SELECT pg_advisory_xact_lock(99111712)',{},t);return fn(t);});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeRef=v=>String(v||'').slice(0,160);
const checkoutHost=url=>{try{const u=new URL(url);return u.protocol==='https:'&&/(^|\.)infinitepay\.io$/i.test(u.hostname);}catch{return false;}};
async function merchant(id,provider){
 const g=await one(`SELECT credentials_enc,account_ref FROM partner_portal_seller_gateways
   WHERE partner_id=:id AND provider=:provider AND active=true`,{id,provider});
 if(!g)err(409,'MERCHANT_NOT_CONFIGURED','O vendedor ainda não configurou o gateway selecionado.');
 const credentials=JSON.parse(decryptSecret(g.credentials_enc));
 if(provider==='infinitepay')return createInfinitePay({handle:g.account_ref,apiKey:credentials.accessToken});
 if(!credentials.webhookSecret)err(409,'WEBHOOK_SECRET_MISSING','O vendedor precisa configurar o segredo de webhook do Mercado Pago.');
 return createMercadoPago({accessToken:credentials.accessToken,webhookSecret:credentials.webhookSecret});
}
async function invitation(inviteId,sellerId=null){
 const row=await one(`SELECT i.*,p.name AS merchant_name,p.contact_email AS merchant_email
 FROM partner_portal_sales_invitations i JOIN partners p ON p.id=i.seller_partner_id WHERE i.id=:inviteId
 ${sellerId?'AND i.seller_partner_id=:sellerId':''}`,{inviteId,...(sellerId?{sellerId}:{})});
 if(!row)err(404,'COMMERCIAL_INVITE_MISSING','Convite comercial não encontrado.');
 return row;
}
export async function createResaleCheckout(inviteId,sellerId,{actor}={}){
 if(actor?.type!=='partner'||actor.partnerId!==sellerId)err(403,'NOT_MERCHANT','Apenas o vendedor cria a própria cobrança.');
 let row=await invitation(inviteId,sellerId);
 if(row.status!=='pending'||row.payment_status==='paid')err(409,'INVITE_FINALIZED','Convite encerrado ou já pago.');
 if(row.payment_gateway==='manual')err(409,'EXTERNAL_PAYMENT_ONLY','Convite de pagamento externo não possui checkout.');
 if(row.checkout_url||row.payment_pix_code)return row;
 if(!Number.isSafeInteger(Number(row.payment_total_cents))||Number(row.payment_total_cents)<100)
  err(422,'PAYMENT_MINIMUM','O checkout exige valor mínimo de R$ 1,00.');
 const expiry=await tx(async t=>{
  const current=await one('SELECT * FROM partner_portal_sales_invitations WHERE id=:inviteId FOR UPDATE',{inviteId},t);
  if(current.status!=='pending'||current.payment_status==='paid')err(409,'INVITE_FINALIZED','Convite encerrado.');
  if(current.checkout_url||current.payment_pix_code)return null;
  if(current.payment_expires_at)return current.payment_expires_at;
  const until=new Date(Math.min(new Date(current.expires_at).getTime(),Date.now()+24*3600_000));
  await run(`UPDATE partner_portal_sales_invitations SET payment_expires_at=:until WHERE id=:inviteId`,{inviteId,until},t);
  return until;
 });
 if(expiry===null)return invitation(inviteId,sellerId);
 if(new Date(expiry).getTime()<=Date.now())err(409,'CHECKOUT_EXPIRED','Prazo da cobrança encerrado. Gere um novo convite.');
 row=await invitation(inviteId,sellerId);
 const gateway=await merchant(sellerId,row.payment_gateway);
 const description=`Pacote de Serviço DeltaTV · ${row.months} meses · ${row.plan_code}`;
 const webhook=`${env.publicBaseUrl}/api/v1/webhooks/portal-sales/resale/${row.payment_gateway}/${sellerId}`;
 let result;
 if(row.payment_gateway==='infinitepay'){
  result=await gateway.createLink({orderNsu:row.id,amountCents:Number(row.payment_total_cents),description,
   validUntil:new Date(expiry),singlePayment:true,
   redirectUrl:`${env.partnerPortalUrl}/?portal_invite_payment=${row.id}`,webhookUrl:webhook});
  if(!checkoutHost(result.url))err(502,'INVALID_PAYMENT_HOST','O provedor retornou endereço inesperado.');
 }else{
  result=await gateway.createCharge({id:row.id,amountCents:Number(row.payment_total_cents),description,
   payer:{email:row.invited_email,name:row.invited_name},expiresAt:new Date(expiry),notificationUrl:webhook});
 }
 await tx(async t=>{
  const current=await one('SELECT * FROM partner_portal_sales_invitations WHERE id=:inviteId FOR UPDATE',{inviteId},t);
  if(current.status!=='pending'||current.checkout_url||current.payment_pix_code)return;
  await run(`UPDATE partner_portal_sales_invitations SET checkout_url=:url,payment_pix_code=:pix,payment_provider_ref=:reference,updated_at=now()
    WHERE id=:inviteId`,{inviteId,url:result.url||result.ticketUrl||null,pix:result.qrCode||null,reference:result.providerRef||null},t);
  await audit({actor,action:'portal.resale.checkout.created',entityType:'portal_sales_invitation',entityId:inviteId,
    metadata:{sellerId,provider:row.payment_gateway,totalCents:Number(row.payment_total_cents)},transaction:t});
 });
 return invitation(inviteId,sellerId);
}
async function settle(row,{provider,reference,transactionNsu=null,slug=null,amountCents}){
 if(!Number.isSafeInteger(Number(amountCents))||Number(amountCents)!==Number(row.payment_total_cents))
  err(409,'PAYMENT_AMOUNT_MISMATCH','Valor confirmado pelo provedor difere do pedido. Revisão financeira necessária.');
 return tx(async t=>{
  const current=await one('SELECT * FROM partner_portal_sales_invitations WHERE id=:id FOR UPDATE',{id:row.id},t);
  if(!current)return {ignored:true};
  if(current.payment_status==='paid')return {paid:true,idempotent:true};
  if(current.status!=='pending')err(409,'PAYMENT_AFTER_CANCELLATION','Pagamento recebido para convite encerrado. Conciliar/reembolsar manualmente.');
  if(current.payment_gateway!==provider)err(409,'PAYMENT_GATEWAY_MISMATCH','O pagamento não pertence ao gateway do pedido.');
  const identity=`${provider}:${row.seller_partner_id}:${reference}`;
  const extended=new Date(Math.max(new Date(current.expires_at).getTime(),Date.now()+7*86400_000));
  await run(`UPDATE partner_portal_sales_invitations SET payment_status='paid',paid_at=now(),
    payment_reference=:identity,payment_transaction_nsu=:transactionNsu,payment_slug=:slug,
    expires_at=:extended,updated_at=now() WHERE id=:id`,
   {id:row.id,identity,transactionNsu,slug,extended},t);
  await audit({actor:{type:'system',id:null},action:'portal.resale.payment.verified',entityType:'portal_sales_invitation',entityId:row.id,
   metadata:{sellerId:row.seller_partner_id,provider,amountCents:Number(amountCents),stockAlreadyReserved:true},transaction:t});
  return {paid:true};
 });
}
export async function verifyResaleInfinitePay(inviteId,sellerId,{transactionNsu,slug}){
 const row=await invitation(inviteId,sellerId);
 if(row.payment_gateway!=='infinitepay')return {ignored:true};
 if(row.payment_status==='paid')return {paid:true,idempotent:true};
 if(!transactionNsu||!slug)return {paid:false,reason:'missing_identifiers'};
 const check=await (await merchant(sellerId,'infinitepay')).paymentCheck({orderNsu:row.id,transactionNsu,slug});
 if(!check.paid)return {paid:false};
 return settle(row,{provider:'infinitepay',reference:transactionNsu,transactionNsu,slug,amountCents:check.amountCents});
}
export async function handleResaleInfinitePayWebhook(sellerId,body){
 if(!UUID.test(sellerId)||!UUID.test(String(body?.order_nsu||''))||!body?.transaction_nsu||!(body?.invoice_slug||body?.slug))return {ignored:true};
 const row=await invitation(body.order_nsu,sellerId).catch(e=>{if(e.status===404)return null;throw e;});
 if(!row||row.payment_gateway!=='infinitepay')return {ignored:true};
 return verifyResaleInfinitePay(row.id,sellerId,{transactionNsu:safeRef(body.transaction_nsu),slug:safeRef(body.invoice_slug||body.slug)});
}
export async function handleResaleMercadoPagoWebhook(sellerId,req){
 if(!UUID.test(sellerId))return {ignored:true};
 const adapter=await merchant(sellerId,'mercadopago');
 if(!adapter.verifyWebhook(req))err(401,'WEBHOOK_SIGNATURE_INVALID','Assinatura do Mercado Pago inválida.');
 const paymentId=adapter.paymentIdFromWebhook(req);
 if(!paymentId)return {ignored:true};
 return verifyResaleMercadoPago(sellerId,String(paymentId));
}
async function verifyResaleMercadoPago(sellerId,reference){
 const payment=await (await merchant(sellerId,'mercadopago')).getPayment(reference);
 if(!UUID.test(String(payment.externalReference||'')))return {ignored:true};
 const row=await invitation(payment.externalReference,sellerId).catch(e=>{if(e.status===404)return null;throw e;});
 if(!row||row.payment_gateway!=='mercadopago'||row.payment_provider_ref!==String(payment.providerRef))return {ignored:true};
 if(payment.status!=='paid')return {paid:false,status:payment.status};
 return settle(row,{provider:'mercadopago',reference:String(payment.providerRef),amountCents:payment.amountCents});
}
export async function recheckResaleCheckout(inviteId,sellerId,{actor,transactionNsu,slug}={}){
 if(actor?.partnerId!==sellerId||actor?.type!=='partner')err(403,'NOT_MERCHANT','Ação exclusiva do vendedor.');
 const row=await invitation(inviteId,sellerId);
 if(row.payment_status==='paid')return {paid:true,idempotent:true};
 if(row.payment_gateway==='infinitepay'){
  if(!transactionNsu||!slug)err(422,'INFINITEPAY_CHECK_IDENTIFIERS','Informe transaction_nsu e slug para conferir na InfinitePay.');
  return verifyResaleInfinitePay(inviteId,sellerId,{transactionNsu,slug});
 }
 if(row.payment_gateway==='mercadopago'&&row.payment_provider_ref)return verifyResaleMercadoPago(sellerId,row.payment_provider_ref);
 return {paid:false};
}
export async function publicRecheckResaleInvite(token,{transactionNsu,slug}={}){
 // Token de convite é o único identificador aceito do comprador anônimo.
 const crypto=await import('node:crypto');
 const hash=crypto.createHash('sha256').update(token).digest('hex');
 const row=await one(`SELECT id,seller_partner_id,payment_gateway,payment_status,payment_provider_ref FROM partner_portal_sales_invitations
 WHERE token_hash=:hash AND status='pending' AND expires_at>now()`,{hash});
 if(!row)err(404,'INVITE_INVALID','Convite indisponível.');
 if(row.payment_status==='paid')return {paid:true};
 if(row.payment_gateway==='mercadopago'&&row.payment_provider_ref)return verifyResaleMercadoPago(row.seller_partner_id,row.payment_provider_ref);
 if(row.payment_gateway==='infinitepay'&&transactionNsu&&slug)return verifyResaleInfinitePay(row.id,row.seller_partner_id,{transactionNsu,slug});
 return {paid:false,needsReturnIdentifiers:row.payment_gateway==='infinitepay'};
}

/** Pagamento externo de venda do Painel do Parceiro: baixa exclusiva do vendedor
 * após verificação do dinheiro recebido na sua conta. Não confundir com estoque comprado da DeltaTV. */
export async function confirmManualResalePayment(inviteId,sellerId,{reference,currentPassword,confirmReceived},actor){
 if(actor?.type!=='partner'||actor.partnerId!==sellerId)err(403,'NOT_MERCHANT','Apenas o vendedor pode confirmar o seu recebimento.');
 if(confirmReceived!==true)err(422,'PAYMENT_CONFIRMATION_REQUIRED','Confirme que o valor entrou na sua conta.');
 const seller=await one('SELECT can_view_finance,active,can_sell FROM partner_portal_sellers WHERE partner_id=:sellerId',{sellerId});
 if(!seller?.active||!seller?.can_sell||!seller?.can_view_finance)err(403,'FINANCIAL_PERMISSION_REQUIRED','Sua conta não pode confirmar pagamentos.');
 const user=await AdminUser.findByPk(actor.id);
 if(!user||!await verifyPassword(currentPassword,user.passwordHash))err(403,'PASSWORD_CONFIRMATION_REQUIRED','Confirme a senha do vendedor.');
 const normalized=String(reference||'').trim();
 if(normalized.length<6||normalized.length>120)err(422,'REFERENCE_REQUIRED','Informe a referência bancária da transferência recebida.');
 return tx(async t=>{
  const row=await one('SELECT * FROM partner_portal_sales_invitations WHERE id=:inviteId FOR UPDATE',{inviteId},t);
  if(!row||row.seller_partner_id!==sellerId)err(404,'INVITE_NOT_FOUND','Convite não encontrado.');
  if(row.payment_gateway!=='manual')err(409,'NOT_EXTERNAL_PAYMENT','Esta cobrança exige confirmação pelo gateway.');
  if(row.payment_status==='paid')return {paid:true,idempotent:true};
  if(row.status!=='pending'||new Date(row.expires_at)<=new Date())err(409,'INVITE_CLOSED','Convite encerrado ou expirado.');
  const identity=`manual:${sellerId}:${normalized}`;
  await run(`UPDATE partner_portal_sales_invitations SET payment_status='paid',paid_at=now(),
    payment_reference=:identity,updated_at=now() WHERE id=:inviteId`,{identity,inviteId},t);
  await audit({actor,action:'portal.resale.external_payment.confirmed',entityType:'portal_sales_invitation',entityId:inviteId,
    metadata:{sellerId,amountCents:Number(row.payment_total_cents),reference:normalized,bankCreditVerifiedBySeller:true},transaction:t});
  return {paid:true};
 });
}
