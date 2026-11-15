import {QueryTypes} from 'sequelize';
import {sequelize} from '../../db/models/index.js';
import {env} from '../../config/env.js';
import {audit} from '../../shared/audit.js';
import {AppError,notFound} from '../../shared/errors.js';
import {createInfinitePay} from '../distribution/gateways/infinitepay.js';
import {createMercadoPago} from '../pix/providers/mercadopago.js';
import {isCheckoutDomain,providerAvailable,PORTAL_PAYMENT_GATEWAYS,postgresMigrationError} from './checkout.rules.js';
import {settleVerifiedPortalOrder} from './sales.service.js';

const read=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction});
const one=async(sql,replacements={},transaction)=>(await read(sql,replacements,transaction))[0]??null;
const run=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,transaction});
const reject=(code,message,status=409)=>{throw new AppError(status,code,message)};
const gatewayConfig=()=>({infinitepayHandle:env.infinitepayHandle,infinitepayApiKey:env.infinitepayApiKey,
 mpAccessToken:env.mpAccessToken,mpWebhookSecret:env.mpWebhookSecret});
const available=provider=>providerAvailable(provider,gatewayConfig());
const safe=(p)=>PORTAL_PAYMENT_GATEWAYS.includes(p);
const tools=()=>({
  infinitepay:createInfinitePay({handle:env.infinitepayHandle,apiKey:env.infinitepayApiKey}),
  mercadopago:createMercadoPago({accessToken:env.mpAccessToken,webhookSecret:env.mpWebhookSecret})
});

export async function paymentSettings(){
  let row;
  try{row=await one('SELECT default_gateway,updated_at FROM partner_portal_payment_settings WHERE singleton_id=1');}
  catch(e){if(postgresMigrationError(e))reject('PORTAL_SALES_MIGRATION_REQUIRED',
    'Configuração de pagamentos não migrada. Faça backup e execute npm run db:migrate no backend.',503);throw e;}
  return {defaultGateway:row?.default_gateway||'manual',availableGateways:PORTAL_PAYMENT_GATEWAYS.map(provider=>({
    provider,enabled:available(provider),label:{manual:'Conferência manual',infinitepay:'InfinitePay (Pix / cartão)',mercadopago:'Mercado Pago (Pix)'}[provider]
  })),credentials:{infinitepayHandlePresent:Boolean(env.infinitepayHandle),infinitepayKeyPresent:Boolean(env.infinitepayApiKey),mercadoPagoConfigured:available('mercadopago')},updatedAt:row?.updated_at||null};
}
export async function setDefaultGateway(provider,actor){
  if(actor?.role!=='superadmin')reject('SUPERADMIN_ONLY','Somente o Superadmin define o meio padrão de pagamento.',403);
  if(!safe(provider))reject('GATEWAY_INVALID','Meio de pagamento desconhecido.',422);
  if(!available(provider))reject('GATEWAY_CONFIG_MISSING','Configure as credenciais do provedor no .env do backend e reinicie o serviço.',422);
  await sequelize.transaction(async t=>{
    await run(`UPDATE partner_portal_payment_settings SET default_gateway=:provider,updated_by=:by,updated_at=now()
      WHERE singleton_id=1`,{provider,by:actor.id},t);
    await audit({actor,action:'portal.sales.payment.default_gateway',entityType:'portal_payment_settings',entityId:null,
      metadata:{provider},transaction:t});
  });
  return paymentSettings();
}
export async function orderFor(id,{sellerId=null}={}) {
  const row=await one(`SELECT o.*,p.name AS seller_name,p.contact_email AS seller_email
    FROM partner_portal_stock_orders o JOIN partners p ON p.id=o.seller_partner_id WHERE o.id=:id
    ${sellerId?'AND o.seller_partner_id=:sellerId':''}`,{id,...(sellerId?{sellerId}:{})});
  if(!row)throw notFound('Pedido de acesso ao Painel do Parceiro');
  return row;
}
export async function createCheckout(id,{actor,sellerId=null}={}){
  const order=await orderFor(id,{sellerId});
  if(!sellerId&&actor?.role!=='superadmin')reject('SUPERADMIN_ONLY','Ação administrativa restrita.',403);
  if(order.status==='paid')return order;
  if(order.status!=='pending')reject('ORDER_CLOSED','Pedido encerrado.');
  if(order.payment_gateway==='manual')reject('MANUAL_ONLY','Este pedido é de pagamento por conferência manual.');
  if(!available(order.payment_gateway))reject('GATEWAY_CONFIG_MISSING','Credenciais do meio de pagamento ausentes no backend.',503);
  if(order.checkout_url || order.pix_copy_paste){
    if(order.payment_expires_at && new Date(order.payment_expires_at)<=new Date())
      reject('CHECKOUT_EXPIRED','Este checkout expirou. Não reutilize o link: gere outro pedido.');
    return order;
  }
  if(!Number.isSafeInteger(Number(order.total_cents))||Number(order.total_cents)<100)
    reject('CHECKOUT_MIN_AMOUNT','O checkout exige valor mínimo de R$ 1,00.',422);
  // Reserva uma data de validade fixa ANTES da requisição externa. Duas chamadas
  // concorrentes usam o mesmo payload; na InfinitePay o order_nsu isolado não é idempotente
  // quando o corpo muda (especialmente valid_until).
  const expiry=await sequelize.transaction(async t=>{
    await run('SELECT pg_advisory_xact_lock(99111712)',{},t);
    const locked=await one('SELECT * FROM partner_portal_stock_orders WHERE id=:id FOR UPDATE',{id},t);
    if(locked.status!=='pending')return null;
    if(locked.payment_expires_at)return locked.payment_expires_at;
    const end=new Date(Date.now()+24*60*60*1000);
    await run('UPDATE partner_portal_stock_orders SET payment_expires_at=:end WHERE id=:id',{end,id},t);
    return end;
  });
  if(!expiry)return orderFor(id,{sellerId});
  const expiresAt=new Date(expiry);
  if(expiresAt.getTime()<=Date.now())reject('CHECKOUT_EXPIRED','A validade do checkout terminou. Crie outro pedido.');
  const description=`DeltaTV Painel do Parceiro · ${order.quantity_months} meses · ${order.plan_code}`;
  let result;
  if(order.payment_gateway==='infinitepay'){
    result=await tools().infinitepay.createLink({orderNsu:order.id,amountCents:Number(order.total_cents),description,
      validUntil:expiresAt,singlePayment:true,
      // Retorno do usuário NÃO comprova pagamento; sempre consultar payment_check.
      redirectUrl:`${env.partnerPortalUrl}/?portal_sales_order=${order.id}`,
      webhookUrl:`${env.publicBaseUrl}/api/v1/webhooks/portal-sales/infinitepay`});
    if(!isCheckoutDomain(result.url))reject('CHECKOUT_INVALID_HOST','Link de pagamento inválido.',502);
  }else{
    if(!order.seller_email)reject('PAYER_EMAIL_REQUIRED','Preencha o e-mail do Master antes de emitir a cobrança.',422);
    result=await tools().mercadopago.createCharge({id:order.id,amountCents:Number(order.total_cents),description,
      payer:{email:order.seller_email,name:order.seller_name},expiresAt,
      notificationUrl:`${env.publicBaseUrl}/api/v1/webhooks/portal-sales/mercadopago`});
  }
  // O retorno externo ocorre fora da transação. Se a gravação falhar, uma nova
  // tentativa reutiliza o order_nsu / X-Idempotency-Key em vez de criar outra compra.
  await sequelize.transaction(async t=>{
    await run('SELECT pg_advisory_xact_lock(99111712)',{},t);
    const previous=await one('SELECT * FROM partner_portal_stock_orders WHERE id=:id FOR UPDATE',{id},t);
    if(previous.status!=='pending')return;
    if(previous.checkout_url||previous.pix_copy_paste)return;
    await run(`UPDATE partner_portal_stock_orders SET checkout_url=:url,pix_copy_paste=:pix,
      provider_ref=:ref,payment_expires_at=:expiresAt WHERE id=:id`,{
      id,url:result.url || result.ticketUrl || null,
      pix:result.qrCode || null,ref:result.providerRef||null,expiresAt},t);
    await audit({actor:actor||{type:'system'},action:'portal.sales.stock.checkout_created',entityType:'portal_stock_order',
      entityId:id,metadata:{provider:order.payment_gateway,amountCents:Number(order.total_cents)},transaction:t});
  });
  return orderFor(id,{sellerId});
}

async function confirmInfinitePay(order,{transactionNsu,slug}){
  if(order.payment_gateway!=='infinitepay')return {ignored:true};
  if(order.status==='paid')return {paid:true,idempotent:true};
  if(!available('infinitepay'))reject('GATEWAY_CONFIG_MISSING','InfinitePay não configurada.',503);
  const checked=await tools().infinitepay.paymentCheck({orderNsu:order.id,transactionNsu,slug});
  if(!checked.paid)return {paid:false};
  await settleVerifiedPortalOrder(order.id,{gateway:'infinitepay',transactionNsu,slug,amountCents:checked.amountCents});
  return {paid:true};
}
export async function confirmReturn(orderId,sellerId,{transactionNsu,slug}){
  const order=await orderFor(orderId,{sellerId});
  if(order.payment_gateway!=='infinitepay')reject('GATEWAY_MISMATCH','Confirmação de retorno disponível somente na InfinitePay.');
  return confirmInfinitePay(order,{transactionNsu,slug});
}
export async function verifyInfinitePayAdmin(orderId,{transactionNsu,slug},actor){
  if(actor?.role!=='superadmin')reject('SUPERADMIN_ONLY','Somente o Superadmin pode conferir pagamentos.',403);
  return confirmInfinitePay(await orderFor(orderId),{transactionNsu,slug});
}
export async function handleInfinitePayWebhook(body){
  // Reembolsos/cancelamentos não provam uma compra nova. Reconciliar estornos
  // com atendimento humano; não retirar automaticamente meses já distribuídos.
  if(['refunded','canceled','payment_failed'].includes(String(body?.event??body?.type??'')))return {ignored:true,needsManualReconciliation:true};
  const orderId=String(body?.order_nsu??'');
  if(!/^[0-9a-f-]{36}$/i.test(orderId))return {ignored:true};
  // Webhook NÃO tem assinatura! Nunca acreditar nele sem /payment_check.
  if(!body?.transaction_nsu || !(body?.invoice_slug||body?.slug))return {ignored:true};
  const order=await orderFor(orderId).catch(e=>{if(e.status===404)return null;throw e});
  if(!order||order.payment_gateway!=='infinitepay')return {ignored:true};
  return confirmInfinitePay(order,{transactionNsu:String(body.transaction_nsu).slice(0,160),slug:String(body.invoice_slug||body.slug).slice(0,160)});
}
async function confirmMpRef(ref){
  if(!available('mercadopago'))reject('GATEWAY_CONFIG_MISSING','Mercado Pago não configurado.',503);
  const p=await tools().mercadopago.getPayment(ref);
  if(!p.externalReference || !/^[0-9a-f-]{36}$/i.test(String(p.externalReference)))return {ignored:true};
  const order=await orderFor(p.externalReference).catch(e=>{if(e.status===404)return null;throw e});
  if(!order||order.payment_gateway!=='mercadopago'||order.provider_ref!==String(p.providerRef))return {ignored:true};
  if(p.status!=='paid')return {paid:false,status:p.status};
  await settleVerifiedPortalOrder(order.id,{gateway:'mercadopago',transactionNsu:String(p.providerRef),amountCents:p.amountCents});
  return {paid:true};
}
export async function handleMercadoPagoWebhook(req){
  const adapter=tools().mercadopago;
  if(!adapter.verifyWebhook(req))reject('INVALID_SIGNATURE','Assinatura inválida.',401);
  const paymentId=adapter.paymentIdFromWebhook(req);
  if(!paymentId)return {ignored:true};
  return confirmMpRef(paymentId);
}
export async function checkOrder(id,actor){
  if(actor?.role!=='superadmin')reject('SUPERADMIN_ONLY','Operação administrativa restrita.',403);
  const order=await orderFor(id);
  if(order.status==='paid')return order;
  if(order.payment_gateway==='mercadopago'&&order.provider_ref)await confirmMpRef(order.provider_ref);
  // InfinitePay não permite consultar sem transaction_nsu E slug. Aguarde webhook/retorno.
  return orderFor(id);
}
