import crypto from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize, Partner, AdminUser } from '../../db/models/index.js';
import { AppError, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { encryptSecret, decryptSecret, verifyPassword } from '../../shared/crypto.js';
import { createMercadoPago, verifySignature } from '../pix/providers/mercadopago.js';
import { move as stockMove, balancesOf } from '../stock/stock-ledger.js';
import { ensurePlan } from '../licenses/plan.service.js';
import { requireMaster } from './network.service.js';
import { effectiveResources } from './network.resources.js';
import { env } from '../../config/env.js';
import { totalCents, verifyPaymentMatch, canDeliver, isSettled, reserveCanRelease } from './master-pix.policy.js';

const select = (sql, replacements={}, transaction) => sequelize.query(sql, { replacements, transaction, type:QueryTypes.SELECT });
const exec = (sql, replacements={}, transaction) => sequelize.query(sql, { replacements, transaction, type:QueryTypes.RAW });
const fail = (status,code,message) => new AppError(status,code,message);
const chooseAccount = async(id, transaction) => (await select(`SELECT * FROM reseller_master_pix_accounts WHERE partner_id=:id`,{id},transaction))[0];
const chooseOrder = async(id, transaction, lock=false) => (await select(`SELECT * FROM reseller_master_pix_orders WHERE id=:id ${lock?'FOR UPDATE':''}`,{id},transaction))[0];
const providerOf = (acct) => createMercadoPago({accessToken: decryptSecret(acct.access_token_enc), webhookSecret:decryptSecret(acct.webhook_secret_enc)});
const webUrl = sellerId => `${env.publicBaseUrl}/api/v1/webhooks/master-pix/mercadopago/${sellerId}`;

export function publicOrder(o) {
  if(!o) return null;
  return {
    id:o.id, buyerPartnerId:o.buyer_partner_id, sellerPartnerId:o.seller_partner_id,
    months:Number(o.months), quantity:Number(o.quantity), unitPriceCents:Number(o.unit_price_cents),
    totalCents:Number(o.total_cents), status:o.status, qrCode:o.status==='pending'?o.qr_code:null,
    ticketUrl:o.status==='pending'?o.ticket_url:null, expiresAt:o.expires_at,
    createdAt:o.created_at, paidAt:o.paid_at, fulfilledAt:o.fulfilled_at,
    reviewReason:o.status==='review'?o.review_reason:null,
  };
}

export async function mySettings(sellerId, {admin=false}={}) {
  if(!admin) await requireMaster(sellerId,'canSell');
  const a=await chooseAccount(sellerId);
  return {configured:!!a,enabled:!!a?.active,provider:'mercadopago',webhookUrl:webUrl(sellerId),
    merchantId:a?.merchant_id || null,updatedAt:a?.updated_at || null,
    pendingPayments:a?Number((await select(`SELECT count(*)::int AS n FROM reseller_master_pix_orders
      WHERE seller_partner_id=:id AND status IN ('creating','pending','review')`,{id:sellerId}))[0]?.n||0):0};
}

async function merchantFromToken(token) {
  // URL constante (sem entrada do usuário): não há SSRF. Token nunca vai para log ou cliente.
  let response;
  try {
    response=await fetch('https://api.mercadopago.com/users/me',{
      headers:{Authorization:`Bearer ${token}`}, signal:AbortSignal.timeout(12000),
    });
  } catch { throw fail(502,'MP_UNREACHABLE','Não foi possível validar a conta Mercado Pago. Tente novamente.'); }
  if(!response.ok) throw fail(422,'MP_INVALID_TOKEN','Credencial Mercado Pago inválida ou sem permissão.');
  const body=await response.json().catch(()=>null);
  if(!/^\d{1,20}$/.test(String(body?.id??''))) throw fail(502,'MP_INVALID_ACCOUNT','Não foi possível identificar a conta recebedora.');
  return String(body.id);
}

export async function saveSettings(sellerId, {accessToken,webhookSecret,currentPassword,active=true}, actor, {admin=false}={}) {
  if(!admin) await requireMaster(sellerId,'canSell');
  const author=actor?.id?await AdminUser.findByPk(actor.id):null;
  if(!author || author.status!=='active' || !(await verifyPassword(currentPassword,author.passwordHash)))
    throw fail(403,'PASSWORD_CONFIRMATION_REQUIRED','Senha da sua conta incorreta. Confirme sua identidade para alterar recebimentos.');
  const merchantId=await merchantFromToken(accessToken);
  return sequelize.transaction(async t => {
    await exec('SELECT pg_advisory_xact_lock(99111701)',{},t);
    const p=await Partner.findByPk(sellerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(!p || p.distributionRole!=='master') throw fail(403,'NOT_MASTER','Ative a conta como Master antes de configurar Pix.');
    if(!admin) await requireMaster(sellerId,'canSell',t);
    const existing=await chooseAccount(sellerId,t);
    if(existing){
      const live=Number((await select(`SELECT count(*)::int AS n FROM reseller_master_pix_orders
        WHERE seller_partner_id=:id AND status IN ('creating','pending','review')`,{id:sellerId},t))[0]?.n||0);
      if(live) throw fail(409,'MP_PENDING_PAYMENTS','Existem cobranças pendentes ou em análise. Concilie antes de trocar credenciais.');
    }
    await exec(`INSERT INTO reseller_master_pix_accounts(partner_id,access_token_enc,webhook_secret_enc,merchant_id,active)
      VALUES(:id,:token,:secret,:merchant,:active) ON CONFLICT(partner_id) DO UPDATE SET
      access_token_enc=EXCLUDED.access_token_enc,webhook_secret_enc=EXCLUDED.webhook_secret_enc,
      merchant_id=EXCLUDED.merchant_id,active=EXCLUDED.active,updated_at=now()`,{
      id:sellerId,token:encryptSecret(accessToken),secret:encryptSecret(webhookSecret),merchant:merchantId,active,
    },t);
    await audit({actor,action:'distribution.pix.account.configured',entityType:'partner',entityId:sellerId,
      metadata:{provider:'mercadopago',merchantId,enabled:active},transaction:t});
    return {configured:true,enabled:active,provider:'mercadopago',merchantId,webhookUrl:webUrl(sellerId)};
  });
}

export async function setActive(sellerId, active,actor,{admin=false}={}) {
  if(!admin) await requireMaster(sellerId,'canSell');
  return sequelize.transaction(async t => {
    await exec('SELECT pg_advisory_xact_lock(99111701)',{},t);
    const current=await chooseAccount(sellerId,t);
    if(!current)throw fail(409,'MP_NOT_CONFIGURED','Configure o Pix antes de ativar as vendas.');
    if(!admin) await requireMaster(sellerId,'canSell',t);
    if(!active){
      const n=(await select(`SELECT count(*)::int AS n FROM reseller_master_pix_orders
        WHERE seller_partner_id=:id AND status IN ('creating','pending','review')`,{id:sellerId},t))[0]?.n;
      if(Number(n)>0) throw fail(409,'MP_PENDING_PAYMENTS','Concilie as cobranças pendentes antes de desativar o Pix.');
    }
    await exec(`UPDATE reseller_master_pix_accounts SET active=:active,updated_at=now() WHERE partner_id=:id`,{id:sellerId,active},t);
    await audit({actor,action:'distribution.pix.account.status',entityType:'partner',entityId:sellerId,metadata:{active},transaction:t});
    return {enabled:active};
  });
}

export async function listOwnPrices(sellerId,{admin=false}={}) {
  if(!admin)await requireMaster(sellerId,'canSell');
  return select(`SELECT months,unit_price_cents AS "unitPriceCents",active FROM reseller_master_pix_prices
    WHERE partner_id=:id ORDER BY months`,{id:sellerId});
}
export async function savePrice(sellerId, {months,unitPriceCents,active}, actor,{admin=false}={}) {
  if(!admin)await requireMaster(sellerId,'canSell');
  await sequelize.transaction(async t=>{
    await exec('SELECT pg_advisory_xact_lock(99111701)',{},t);
    if(!admin)await requireMaster(sellerId,'canSell',t);
    else {const target=await Partner.findByPk(sellerId,{transaction:t}); if(!target || target.distributionRole!=='master')throw fail(403,'NOT_MASTER','Conta não é Master.');}
    await ensurePlan(months,{transaction:t});
    await exec(`INSERT INTO reseller_master_pix_prices(partner_id,months,unit_price_cents,active)
      VALUES(:id,:months,:cents,:active) ON CONFLICT(partner_id,months)
      DO UPDATE SET unit_price_cents=EXCLUDED.unit_price_cents,active=EXCLUDED.active,updated_at=now()`,
      {id:sellerId,months,cents:unitPriceCents,active},t);
    await audit({actor,action:'distribution.pix.price.set',entityType:'partner',entityId:sellerId,metadata:{months,unitPriceCents,active},transaction:t});
  });
  return {months,unitPriceCents,active};
}

export async function offersForBuyer(buyerId) {
  const buyer=await Partner.findByPk(buyerId,{attributes:['id','parentPartnerId']});
  if(!buyer?.parentPartnerId)return {seller:null,offers:[]};
  const seller=await Partner.findByPk(buyer.parentPartnerId,{attributes:['id','name']});
  const account=await chooseAccount(seller.id);
  if(!account?.active)return {seller:{id:seller.id,name:seller.name},offers:[]};
  try{await requireMaster(seller.id,'canSell');}catch{return {seller:{id:seller.id,name:seller.name},offers:[]};}
  const offers=await select(`SELECT months,unit_price_cents AS "unitPriceCents" FROM reseller_master_pix_prices
    WHERE partner_id=:id AND active=true ORDER BY months`,{id:seller.id});
  return {seller:{id:seller.id,name:seller.name},offers:offers.map(o=>({...o,unitPriceCents:Number(o.unitPriceCents)}))};
}

async function assertBuyer(buyerId,sellerId,t){
  // Ordem determinística de locks, compatível com o financeiro legado.
  const locked=await Partner.findAll({where:{id:[buyerId,sellerId].sort()},transaction:t,lock:t.LOCK.UPDATE});
  const buyer=locked.find(p=>p.id===buyerId),seller=locked.find(p=>p.id===sellerId);
  if(buyer?.parentPartnerId!==sellerId || buyer.status!=='active' || seller?.status!=='active')
    throw fail(403,'NETWORK_LINK_CHANGED','A revenda não está ativa ou mudou de Master.');
  await requireMaster(sellerId,'canSell',t);
  const resources=await effectiveResources(buyerId,t);
  if(!resources.stock.enabled)throw fail(403,'STOCK_DISABLED','Seu Master desativou compras de licenças para esta revenda.');
  return {buyer,seller};
}

const orderViewFor=async(buyerId,id)=>{
  const order=await chooseOrder(id);
  if(!order||order.buyer_partner_id!==buyerId)throw notFound('Cobrança Pix da sua revenda');
  return order;
};

/** Reserva estoque ANTES de chamar MP. Requisições repetidas recuperam a mesma cobrança. */
export async function startOrder(buyerId,{months,quantity,expectedUnitPriceCents,idempotencyKey,document},actor){
  let order=await sequelize.transaction(async t=>{
    await exec('SELECT pg_advisory_xact_lock(99111701)',{},t);
    await exec('SELECT pg_advisory_xact_lock(hashtext(:key))',{key:`masterpix:${buyerId}:${idempotencyKey}`},t);
    const prev=(await select(`SELECT * FROM reseller_master_pix_orders WHERE buyer_partner_id=:buyer AND idempotency_key=:key FOR UPDATE`,
      {buyer:buyerId,key:idempotencyKey},t))[0];
    if(prev){
      if(Number(prev.months)!==months || Number(prev.quantity)!==quantity || Number(prev.unit_price_cents)!==expectedUnitPriceCents)
        throw fail(409,'IDEMPOTENCY_MISMATCH','Esta tentativa de compra já existe com outros valores.');
      return prev;
    }
    const buyer=await Partner.findByPk(buyerId,{transaction:t});
    if(!buyer?.parentPartnerId)throw fail(422,'NO_MASTER','Sua revenda não está vinculada a um Master.');
    const sellerId=buyer.parentPartnerId;
    const {seller}=await assertBuyer(buyerId,sellerId,t);
    const acct=await chooseAccount(sellerId,t);
    if(!acct?.active)throw fail(422,'MASTER_PIX_DISABLED','Seu Master ainda não habilitou recebimentos por Pix.');
    const price=(await select(`SELECT unit_price_cents FROM reseller_master_pix_prices
      WHERE partner_id=:seller AND months=:months AND active=true FOR UPDATE`,{seller:sellerId,months},t))[0];
    if(!price)throw fail(422,'PRICE_NOT_AVAILABLE','Esta licença não está à venda por Pix.');
    if(Number(price.unit_price_cents)!==expectedUnitPriceCents)
      throw fail(409,'PRICE_CHANGED','O preço mudou. Atualize a oferta antes de pagar.');
    const total=totalCents(expectedUnitPriceCents,quantity);
    if(!total)throw fail(422,'INVALID_AMOUNT','Valor total de compra inválido.');
    // Sempre travado pela própria operação UPDATE em stockMove; protege de compras simultâneas.
    const id=crypto.randomUUID();
    await stockMove(t,{partnerId:sellerId,months,delta:-quantity,kind:'transfer_out',
      counterpartyPartnerId:buyerId,transferId:id,
      note:`Pix Master ${id}: estoque RESERVADO, ainda não entregue`,actor});
    const inserted=(await select(`INSERT INTO reseller_master_pix_orders
      (id,buyer_partner_id,seller_partner_id,months,quantity,unit_price_cents,total_cents,idempotency_key,actor_user_id)
      VALUES(:id,:buyer,:seller,:months,:quantity,:unit,:total,:key,:user) RETURNING *`,
      {id,buyer:buyerId,seller:seller.id,months,quantity,unit:expectedUnitPriceCents,total,key:idempotencyKey,user:actor?.id??null},t))[0];
    await audit({actor,action:'distribution.pix.order.reserved',entityType:'partner',entityId:buyerId,
      metadata:{orderId:id,sellerId,months,quantity,totalCents:total},transaction:t});
    return inserted;
  });
  if(order.status==='creating' && !order.provider_ref)order=await issuePayment(order,document);
  else if(order.status==='creating')order=await reconcileOrder(order.id,{force:true});
  return publicOrder(order);
}

// A chave do pedido é a chave idempotente do Mercado Pago. POST repetido não cria segunda cobrança.
async function issuePayment(order,document){
  const acct=await chooseAccount(order.seller_partner_id);
  if(!acct?.active)throw fail(409,'MASTER_PIX_DISABLED','O recebimento deste Master está desativado.');
  const buyerUser=order.actor_user_id?await AdminUser.findByPk(order.actor_user_id):null;
  const buyer=await Partner.findByPk(order.buyer_partner_id);
  const payerEmail=buyerUser?.email || buyer?.contactEmail;
  if(!payerEmail)throw fail(422,'PAYER_EMAIL_REQUIRED','Cadastre um e-mail válido para realizar o Pix.');
  const provider=providerOf(acct);
  const expires=new Date(Date.now()+60*60*1000);
  const charge=await provider.createCharge({id:order.id,amountCents:Number(order.total_cents),
    description:`DeltaTV: ${order.quantity} licenças de ${order.months} meses`,
    payer:{email:payerEmail,name:buyer?.name,document},expiresAt:expires,notificationUrl:webUrl(order.seller_partner_id)});
  const updated=await sequelize.transaction(async t=>{
    const current=await chooseOrder(order.id,t,true);
    if(!current)throw notFound('Cobrança Pix');
    if(current.provider_ref && current.provider_ref!==charge.providerRef)
      throw fail(409,'PROVIDER_CONFLICT','Referência de pagamento divergente; encaminhado à conciliação.');
    // Um webhook pode ter chegado antes da resposta do POST. Nunca rebaixar status pago.
    if(isSettled(current.status)||current.status==='review')return current;
    return (await select(`UPDATE reseller_master_pix_orders SET provider_ref=:ref,
      status='pending',qr_code=:qr,ticket_url=:url,expires_at=:expires,
      updated_at=now() WHERE id=:id RETURNING *`,
      {id:order.id,ref:charge.providerRef,qr:charge.qrCode,url:charge.ticketUrl,expires:charge.expiresAt},t))[0];
  });
  // Pix aprovado instantaneamente é confirmado pela consulta ao provedor, nunca pelo corpo do POST.
  return updated;
}

/** Consulta autenticada ao MP + conciliação transacional. Chamadas concorrentes ficam idempotentes. */
export async function reconcileOrder(id,{force=false}={}) {
  let order=await chooseOrder(id);
  if(!order || (isSettled(order.status) && !(force && order.status==='paid')))return order;
  if(order.status==='review' && !force)return order;
  if(!force && order.checked_at && Date.now()-new Date(order.checked_at).getTime()<6500)return order;
  const account=await chooseAccount(order.seller_partner_id);
  if(!account)throw fail(503,'MASTER_PIX_CONFIG_MISSING','Conta recebedora indisponível para conciliação.');
  if(!order.provider_ref){
    if(order.status==='creating')return issuePayment(order);
    return order;
  }
  const provider=providerOf(account);
  const payment=await provider.getPayment(order.provider_ref);
  return sequelize.transaction(async t=>{
    await exec('SELECT pg_advisory_xact_lock(99111701)',{},t);
    const current=await chooseOrder(id,t,true);
    if(!current)return current;
    if(current.status==='paid'){
      if(['refunded','cancelled'].includes(payment.status) || Number(payment.refundedAmountCents||0)>0){
        await audit({actor:{type:'system',name:'Pix Master'},action:'distribution.pix.payment.reversed',
          entityType:'partner',entityId:current.buyer_partner_id,
          metadata:{orderId:id,providerRef:current.provider_ref,originallyFulfilled:true},transaction:t});
        return (await select(`UPDATE reseller_master_pix_orders SET status='review',
          review_reason='Pix estornado ou cancelado após entrega; investigar recuperação financeira',
          checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`,{id},t))[0];
      }
      return current;
    }
    if(isSettled(current.status))return current;
    // Não confia no webhook: exige valor, referência externa, conta recebedora e ID do pagamento.
    if(!verifyPaymentMatch(current,payment,account.merchant_id)){
      return (await select(`UPDATE reseller_master_pix_orders SET status='review',
        review_reason='Identidade, recebedor, referência ou valor divergente no provedor',checked_at=now(),updated_at=now()
        WHERE id=:id RETURNING *`,{id},t))[0];
    }
    if(Number(payment.refundedAmountCents||0)>0){
      return (await select(`UPDATE reseller_master_pix_orders SET status='review',
        review_reason='Pagamento com reembolso parcial; exige conciliação manual',
        checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`,{id},t))[0];
    }
    if(payment.status==='paid'){
      const locked=await Partner.findAll({where:{id:[current.buyer_partner_id,current.seller_partner_id].sort()},
        transaction:t,lock:t.LOCK.UPDATE});
      const buyer=locked.find(p=>p.id===current.buyer_partner_id);
      const seller=locked.find(p=>p.id===current.seller_partner_id);
      let allowed=false;
      try {
        await requireMaster(current.seller_partner_id,'canSell',t);
        const resource=await effectiveResources(current.buyer_partner_id,t);
        allowed=resource.stock.enabled;
      } catch { allowed=false; }
      if(!allowed || !canDeliver(current,buyer,seller)) {
        return (await select(`UPDATE reseller_master_pix_orders SET status='review',
          review_reason='Pagamento confirmado, mas vínculo ou permissão mudou; exige conciliação',
          paid_at=:paidAt,checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`,
          {id,paidAt:payment.paidAt||new Date()},t))[0];
      }
      await stockMove(t,{partnerId:current.buyer_partner_id,months:Number(current.months),
        delta:Number(current.quantity),kind:'transfer_in',counterpartyPartnerId:current.seller_partner_id,
        transferId:id,note:`Pix Master ${id} confirmado no Mercado Pago`,actor:{type:'system',name:'Pix Master'}});
      await audit({actor:{type:'system',name:'Pix Master'},action:'distribution.pix.order.fulfilled',entityType:'partner',
        entityId:current.buyer_partner_id,metadata:{orderId:id,sellerId:current.seller_partner_id,
        amountCents:Number(current.total_cents),providerRef:current.provider_ref},transaction:t});
      return (await select(`UPDATE reseller_master_pix_orders SET status='paid',paid_at=:paidAt,
        fulfilled_at=now(),qr_code=NULL,checked_at=now(),updated_at=now()
        WHERE id=:id RETURNING *`,{id,paidAt:payment.paidAt||new Date()},t))[0];
    }
    if(reserveCanRelease(payment.status)){
      if(!current.released_at && !current.fulfilled_at){
        await stockMove(t,{partnerId:current.seller_partner_id,months:Number(current.months),
          delta:Number(current.quantity),kind:'transfer_in',counterpartyPartnerId:current.buyer_partner_id,
          transferId:id,note:`Pix Master ${id}: reserva cancelada pelo provedor`,actor:{type:'system',name:'Pix Master'}});
      }
      return (await select(`UPDATE reseller_master_pix_orders SET status=:status,released_at=COALESCE(released_at,now()),
        qr_code=NULL,checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`,
        {id,status:payment.status},t))[0];
    }
    return (await select(`UPDATE reseller_master_pix_orders SET status='pending',checked_at=now(),updated_at=now()
      WHERE id=:id RETURNING *`,{id},t))[0];
  });
}

export async function orderForBuyer(buyerId,id,{refresh=true}={}) {
  let o=await orderViewFor(buyerId,id);
  if(refresh && ['pending','creating'].includes(o.status)){
    try {o=await reconcileOrder(id);} catch(e){
      if(e.status!==502 && e.status!==503)throw e;
      // Uma indisponibilidade do provedor não vira falso pagamento.
    }
  }
  return publicOrder(o);
}
export async function ordersFor(partnerId,as='buyer',limit=50){
  const col=as==='seller'?'seller_partner_id':'buyer_partner_id';
  const rows=await select(`SELECT o.*,p.name AS counterparty_name FROM reseller_master_pix_orders o
    JOIN partners p ON p.id=o.${as==='seller'?'buyer_partner_id':'seller_partner_id'}
    WHERE o.${col}=:id ORDER BY o.created_at DESC LIMIT :limit`,{id:partnerId,limit:Math.min(200,limit)});
  return rows.map(r=>({...publicOrder(r),counterpartyName:r.counterparty_name}));
}
/** Financeiro hierárquico: apenas a própria árvore do Master, sem tokens ou dados bancários. */
export async function subtreeReport(masterId,{limit=100}={}) {
  await requireMaster(masterId,'canSell');
  const rows=await select(`WITH RECURSIVE subtree AS (
    SELECT id,0 AS depth,ARRAY[id] AS path FROM partners WHERE id=:master
    UNION ALL SELECT p.id,s.depth+1,s.path||p.id FROM partners p JOIN subtree s ON p.parent_partner_id=s.id
      WHERE NOT (p.id=ANY(s.path))
  ) SELECT o.id,o.seller_partner_id AS "sellerPartnerId",o.buyer_partner_id AS "buyerPartnerId",
    s.depth AS "sellerDepth",v.name AS "sellerName",b.name AS "buyerName",o.months,o.quantity,
    o.total_cents AS "totalCents",o.status,o.created_at AS "createdAt"
    FROM reseller_master_pix_orders o JOIN subtree s ON s.id=o.seller_partner_id
    JOIN partners v ON v.id=o.seller_partner_id JOIN partners b ON b.id=o.buyer_partner_id
    ORDER BY o.created_at DESC LIMIT :limit`,{master:masterId,limit:Math.min(limit,200)});
  const totals=await select(`WITH RECURSIVE subtree AS (
    SELECT id,ARRAY[id] AS path FROM partners WHERE id=:master
    UNION ALL SELECT p.id,s.path||p.id FROM partners p JOIN subtree s ON p.parent_partner_id=s.id
      WHERE NOT(p.id=ANY(s.path))
  ) SELECT count(*)::int AS "completedSales",coalesce(sum(o.total_cents),0)::bigint AS "grossCents"
    FROM reseller_master_pix_orders o JOIN subtree s ON s.id=o.seller_partner_id
    WHERE o.status='paid'`,{master:masterId});
  return {summary:{completedSales:Number(totals[0]?.completedSales||0),grossCents:Number(totals[0]?.grossCents||0)},
    data:rows.map(r=>({...r,totalCents:Number(r.totalCents)}))};
}

export async function adminOrders({limit=100,status,sellerId=null}={}) {
  const rows=await select(`SELECT o.*,b.name AS buyer_name,s.name AS seller_name FROM reseller_master_pix_orders o
    JOIN partners b ON b.id=o.buyer_partner_id JOIN partners s ON s.id=o.seller_partner_id
    WHERE (:status='' OR o.status=:status) AND (:sellerId IS NULL OR o.seller_partner_id=:sellerId)
    ORDER BY o.created_at DESC LIMIT :limit`,{limit:Math.min(limit,500),status:status||'',sellerId});
  return rows.map(r=>({...publicOrder(r),buyerName:r.buyer_name,sellerName:r.seller_name}));
}

export function notificationPaymentId(req){
  const type=req.query?.type??req.query?.topic??req.body?.type??req.body?.topic;
  if(type && type!=='payment')return null;
  const id=req.query?.['data.id']??req.query?.data?.id??req.body?.data?.id;
  return /^\d{1,20}$/.test(String(id??''))?String(id):null;
}
export async function handleWebhook(sellerId,req){
  const acct=await chooseAccount(sellerId);
  if(!acct)throw notFound('Conta recebedora');
  const paymentId=notificationPaymentId(req);
  // Assinatura obrigatória: não aceita a opção permissiva do adaptador geral.
  const valid=verifySignature({secret:decryptSecret(acct.webhook_secret_enc),
    signatureHeader:req.get('x-signature'),requestId:req.get('x-request-id'),
    dataId:req.query?.['data.id']??req.query?.data?.id??req.body?.data?.id});
  if(!valid)throw fail(401,'INVALID_WEBHOOK_SIGNATURE','Assinatura do webhook inválida.');
  if(!paymentId)return {ignored:true};
  const provider=providerOf(acct);
  const payment=await provider.getPayment(paymentId);
  const orderId=payment.externalReference;
  if(!/^[0-9a-f-]{36}$/i.test(String(orderId||'')))return {ignored:true};
  const order=await chooseOrder(orderId);
  if(!order || order.seller_partner_id!==sellerId)return {ignored:true};
  if(order.provider_ref && order.provider_ref!==paymentId)throw fail(409,'PAYMENT_MISMATCH','Pagamento não corresponde à cobrança.');
  if(!order.provider_ref){
    // A confirmação pode chegar antes da resposta da criação. Vincula apenas após consulta ao provedor.
    await sequelize.transaction(async t=>{
      const current=await chooseOrder(orderId,t,true);
      if(current&&!current.provider_ref && String(payment.externalReference)===orderId)
        await exec(`UPDATE reseller_master_pix_orders SET provider_ref=:ref,updated_at=now() WHERE id=:id`,{id:orderId,ref:paymentId},t);
    });
  }
  await reconcileOrder(orderId,{force:true});
  return {accepted:true};
}

/** Reconciliação periódica para webhook perdido. Executar a cada dois minutos, em lotes. */
export async function reconcilePending(limit=30){
  const rows=await select(`SELECT id FROM reseller_master_pix_orders WHERE status IN ('pending','creating')
    AND (checked_at IS NULL OR checked_at < now()-interval '90 seconds')
    ORDER BY checked_at NULLS FIRST,created_at ASC LIMIT :limit`,{limit});
  const stats={checked:0,paid:0,errors:0};
  for(const row of rows){
    try{const o=await reconcileOrder(row.id,{force:true});stats.checked++;if(o?.status==='paid')stats.paid++;}
    catch(e){stats.errors++;await exec(`UPDATE reseller_master_pix_orders SET checked_at=now() WHERE id=:id AND status IN ('pending','creating')`,{id:row.id}).catch(()=>{});
      console.error('[master-pix] falha na conciliação da cobrança',row.id,e.code||e.name);}
  }
  return stats;
}
