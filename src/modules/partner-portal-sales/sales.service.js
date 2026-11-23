import {QueryTypes} from 'sequelize';
import {sequelize} from '../../db/models/index.js';
import {AppError,notFound} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {reclaimCommercialSellerInvites} from './invitations.service.js';
import {postgresMigrationError,verifiedAmountMatches} from './checkout.rules.js';
import {addMonthsUtc,isContentPartner,resaleAllowed,safeTotal,allowedChildRole,forecastMonthlyCost} from './sales.rules.js';
import {packageSnapshot} from './commercial-v2.rules.js';
import {activateMasterPackageForPaidOrder} from './commercial-v2.service.js';

const fail=(status,code,message)=>{throw new AppError(status,code,message)};
const adminActor=actor=>{if(actor?.role!=='superadmin')fail(403,'SUPERADMIN_ONLY','Somente o Superadmin pode realizar esta operação.');};
const sellerActor=(actor,sellerPartnerId)=>{if(actor?.type!=='partner'||actor?.role!=='partner'||actor?.partnerId!==sellerPartnerId)fail(403,'SELLER_ACTOR_MISMATCH','Vendedor inválido.');};
const read=async(sql,replacements={},transaction)=>{
  try{return await sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction});}
  catch(e){
    if(postgresMigrationError(e))fail(503,'PORTAL_SALES_MIGRATION_REQUIRED',
      'Tabelas ou colunas comerciais ausentes. Faça backup e execute npm run db:migrate no backend.');
    throw e;
  }
};
const run=async(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,transaction});
const one=async(sql,replacements={},transaction)=>(await read(sql,replacements,transaction))[0]||null;
// Serializa mutações financeiras/contratuais enquanto o módulo ainda está no VPS pequeno.
// Impede que suspensão de Master cruze com transferências de seus descendentes.
const tx=fn=>sequelize.transaction(async t=>{await run('SELECT pg_advisory_xact_lock(99111712)',{},t);return fn(t);});

async function sellerRow(id,t,{locked=false,required=true}={}) {
  const row=await one(`SELECT s.*,p.name,p.kind,p.status,p.status_reason FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id
    WHERE s.partner_id=:id ${locked?'FOR UPDATE OF s':''}`,{id},t);
  if(required && (!row||!isContentPartner(row.kind))) fail(403,'NOT_PORTAL_SELLER','Conta sem autorização para distribuir acessos ao Painel do Parceiro.');
  return row;
}
async function activeSeller(id,t,opts={}) {
  const row=await sellerRow(id,t,opts);
  if(!row.active||!row.can_sell||row.status!=='active')fail(403,'SELLER_INACTIVE','Distribuidor sem permissão ativa para vender.');
  const mp=await one('SELECT status FROM partner_portal_master_packages WHERE partner_id=:id',{id},t);
  if(mp?.status==='pending')fail(402,'MASTER_PAYMENT_PENDING','Confirme o pagamento para liberar as vendas.');
  // Permissão efetiva depende de TODOS os Masters da cadeia; sem limites de profundidade.
  const lineage=await one(`WITH RECURSIVE chain AS (
    SELECT s.partner_id,s.parent_partner_id,s.active,s.can_sell,p.status,ARRAY[s.partner_id] AS visited
    FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id WHERE s.partner_id=:id
    UNION ALL
    SELECT ancestor.partner_id,ancestor.parent_partner_id,ancestor.active,ancestor.can_sell,p.status,
      chain.visited||ancestor.partner_id
    FROM chain JOIN partner_portal_sellers ancestor ON ancestor.partner_id=chain.parent_partner_id
    JOIN partners p ON p.id=ancestor.partner_id
    WHERE NOT ancestor.partner_id=ANY(chain.visited)
  ) SELECT bool_and(active AND can_sell AND status='active') AS allowed,
      count(*) FILTER (WHERE parent_partner_id IS NULL)::int AS root_count FROM chain`,{id},t);
  if(!lineage?.allowed||lineage.root_count!==1)fail(403,'ANCESTOR_BLOCKED','Master ancestral bloqueado ou cadeia comercial inválida.');
  return row;
}
async function planRow(code,t,{active=false}={}) {
  const plan=await one(`SELECT p.*,c.max_apps FROM partner_portal_sales_plans p LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier WHERE p.code=:code`,{code},t);
  if(!plan)throw notFound('Plano comercial do Painel do Parceiro');
  if(active&&!plan.active)fail(409,'PORTAL_PLAN_INACTIVE','Este plano não está à venda.');
  return plan;
}
async function lockStock(id,code,t) {
  await run(`INSERT INTO partner_portal_stock(seller_partner_id,plan_code) VALUES (:id,:code) ON CONFLICT DO NOTHING`,{id,code},t);
  return one(`SELECT * FROM partner_portal_stock WHERE seller_partner_id=:id AND plan_code=:code FOR UPDATE`,{id,code},t);
}
async function spendStock(id,code,months,t) {
  const stock=await lockStock(id,code,t);
  if(Number(stock.available_months)<months)fail(409,'INSUFFICIENT_PORTAL_STOCK','Saldo pré-pago de meses do Painel do Parceiro insuficiente.');
  await run(`UPDATE partner_portal_stock SET available_months=available_months-:months,updated_at=now()
    WHERE seller_partner_id=:id AND plan_code=:code`,{id,code,months},t);
}
async function receiveStock(id,code,months,t) {
  await lockStock(id,code,t);
  await run(`UPDATE partner_portal_stock SET available_months=available_months+:months,updated_at=now()
    WHERE seller_partner_id=:id AND plan_code=:code`,{id,code,months},t);
}
export async function adminOverview() {
  const [plans,sellers,orders,contracts,forecast,finance,invitationSummary]=await Promise.all([
    read('SELECT * FROM partner_portal_sales_plans ORDER BY created_at DESC'),
    read(`SELECT s.*,p.name,p.status,p.public_partner_number,mp.status AS master_package_status,pl.name AS master_package_name,
    COALESCE((SELECT sum(st.available_months) FROM partner_portal_stock st WHERE st.seller_partner_id=s.partner_id),0) AS stock_months
    FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id
    LEFT JOIN partner_portal_master_packages mp ON mp.partner_id=s.partner_id
    LEFT JOIN partner_portal_sales_plans pl ON pl.code=mp.plan_code
    ORDER BY s.created_at DESC LIMIT 200`),
    read(`SELECT o.*,p.name AS seller_name FROM partner_portal_stock_orders o JOIN partners p ON p.id=o.seller_partner_id ORDER BY o.created_at DESC LIMIT 100`),
    read(`SELECT c.*,p.name AS customer_name,s.name AS seller_name FROM partner_portal_access_contracts c JOIN partners p ON p.id=c.customer_partner_id JOIN partners s ON s.id=c.seller_partner_id ORDER BY c.updated_at DESC LIMIT 100`),
    costForecast(),
    one(`SELECT COALESCE(sum(total_cents) FILTER (WHERE status='paid' AND settled_at>=date_trunc('month',now())),0) AS received_this_month_cents,
      COALESCE(sum(total_cents) FILTER (WHERE status='pending'),0) AS pending_cents,
      count(*) FILTER (WHERE status='paid' AND settled_at>=date_trunc('month',now()))::int AS paid_orders_this_month
      FROM partner_portal_stock_orders`),
    one(`SELECT count(*) FILTER (WHERE status='pending' AND expires_at>now())::int AS pending,
      COALESCE(sum(months) FILTER (WHERE status='pending' AND expires_at>now()),0) AS reserved_months,
      count(*) FILTER (WHERE status='accepted')::int AS accepted
      FROM partner_portal_sales_invitations`),
  ]);
  return {plans,sellers,orders,contracts,forecast,invitationSummary,finance:{...finance,estimatedCashAfterForecastCostsCents:Number(finance?.received_this_month_cents||0)-forecast.monthlyFixedCents-forecast.forecastProxyCents},caveat:'Receitas de revenda e mensalidades adicionais são declaradas, não cobradas automaticamente. Pedidos de estoque usam verificação via gateway quando configurada ou conferência manual do Superadmin.'};
}
/** Estado simples para a navegação do Painel do Parceiro.
 * Não retorna IDs de outros distribuidores ou informações financeiras.
 * A falta de autorização é um estado esperado, não um erro que esconda o menu.
 */
export async function sellerEligibility(partnerId) {
  const seller=await sellerRow(partnerId,null,{required:false});
  if(!seller || !isContentPartner(seller.kind)) return {
    registered:false,enabled:false,role:null,
    reason:'Sua conta ainda não está habilitada como Master ou Submaster. Solicite a ativação à DeltaTV.'
  };
  if(seller.status==='suspended'&&seller.status_reason==='PENDING_PORTAL_MASTER_PAYMENT')
   return {registered:true,enabled:false,paymentPending:true,role:seller.role,
    reason:'Aguardando confirmação da compra do Pacote de Serviço. Abra Meu Pacote para pagar.'};
  try {
    await activeSeller(partnerId);
    return {registered:true,enabled:true,role:seller.role,reason:null};
  } catch(e) {
    if(['SELLER_INACTIVE','ANCESTOR_BLOCKED'].includes(e.code)) return {
      registered:true,enabled:false,role:seller.role,
      reason:'A distribuição comercial está suspensa para esta conta ou para um Master ancestral. Consulte a DeltaTV.'
    };
    throw e;
  }
}

export async function sellerOverview(id) {
  await reclaimCommercialSellerInvites(id);
  const seller=await sellerRow(id);
  const [stock,children,transfers,contracts,orders]=await Promise.all([
    read(`SELECT st.plan_code,st.available_months,pl.name AS plan_name,pl.min_resale_cents FROM partner_portal_stock st JOIN partner_portal_sales_plans pl ON pl.code=st.plan_code WHERE st.seller_partner_id=:id ORDER BY st.plan_code`,{id}),
    read(`SELECT s.partner_id,s.parent_partner_id,s.role,s.active,p.name FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id WHERE s.parent_partner_id=:id ORDER BY p.name LIMIT 200`,{id}),
    read(`SELECT * FROM partner_portal_transfers WHERE seller_partner_id=:id OR buyer_partner_id=:id ORDER BY created_at DESC LIMIT 60`,{id}),
    read(`SELECT c.*,p.name AS customer_name FROM partner_portal_access_contracts c JOIN partners p ON p.id=c.customer_partner_id WHERE c.seller_partner_id=:id ORDER BY c.updated_at DESC LIMIT 100`,{id}),
    seller.can_view_finance?read(`SELECT id,plan_code,quantity_months,total_cents,status,payment_gateway,checkout_url,pix_copy_paste,
      payment_expires_at,created_at,settled_at FROM partner_portal_stock_orders
      WHERE seller_partner_id=:id ORDER BY created_at DESC LIMIT 60`,{id}):Promise.resolve([]),
  ]);
  return {seller:{partnerId:seller.partner_id,name:seller.name,role:seller.role,active:seller.active,canSell:seller.can_sell},stock,children,transfers,contracts,orders,
    caveat:'Meses são acessos ao painel de parceiros, não licenças de TV. Valores declarados de repasses não são pagamentos confirmados.'};
}
export async function registerSeller({partnerId,parentPartnerId=null},actor) {
  adminActor(actor);
  return tx(async t=>{
    const p=await one('SELECT id,name,kind,status FROM partners WHERE id=:partnerId FOR UPDATE',{partnerId},t);
    if(!p||!isContentPartner(p.kind))fail(422,'NOT_CONTENT_PARTNER','Selecione uma conta do Painel do Parceiro, não uma Revenda de TVs.');
    if(p.status!=='active')fail(409,'PARTNER_INACTIVE','Parceiro não está ativo.');
    const old=await sellerRow(partnerId,t,{required:false});
    if(old)fail(409,'SELLER_EXISTS','Já é distribuidor. Mudança de árvore exige migração auditada específica.');
    if(parentPartnerId)await activeSeller(parentPartnerId,t,{locked:true});
    if(parentPartnerId){const parent=await sellerRow(parentPartnerId,t);if(!parent.can_create_submasters)fail(403,'SUBMASTER_CREATION_FORBIDDEN','Este Master não tem permissão para cadastrar Submasters.');}
    const role=allowedChildRole(parentPartnerId);
    const r=await one(`INSERT INTO partner_portal_sellers(partner_id,parent_partner_id,role) VALUES (:partnerId,:parentPartnerId,:role)
      RETURNING *`,{partnerId,parentPartnerId,role},t);
    await audit({actor,action:'portal.sales.seller.created',entityType:'partner',entityId:partnerId,metadata:{parentPartnerId,role},transaction:t});
    return r;
  });
}
export async function setSellerState(partnerId,{active,canSell},actor) {
  adminActor(actor);
  return tx(async t=>{
    const current=await sellerRow(partnerId,t,{locked:true});
    const r=await one(`UPDATE partner_portal_sellers SET active=:active,can_sell=:canSell,updated_at=now() WHERE partner_id=:partnerId RETURNING *`,
      {partnerId,active:active??current.active,canSell:canSell??current.can_sell},t);
    await audit({actor,action:'portal.sales.seller.status',entityType:'partner',entityId:partnerId,metadata:{active:r.active,canSell:r.can_sell},transaction:t});
    return r;
  });
}
export async function savePlan({code,name,wholesaleCents,minResaleCents,active=true},actor) {
  adminActor(actor);
  if(minResaleCents<wholesaleCents)fail(422,'PRICE_BELOW_COST','O mínimo de revenda não pode ser menor que o preço-base.');
  return tx(async t=>{
    const record=await one(`INSERT INTO partner_portal_sales_plans(code,name,wholesale_cents,min_resale_cents,active)
      VALUES (:code,:name,:wholesaleCents,:minResaleCents,:active)
      ON CONFLICT (code) DO UPDATE SET name=excluded.name,wholesale_cents=excluded.wholesale_cents,
        min_resale_cents=excluded.min_resale_cents,active=excluded.active,updated_at=now() RETURNING *`,
      {code,name,wholesaleCents,minResaleCents,active},t);
    await audit({actor,action:'portal.sales.plan.updated',entityType:'portal_plan',entityId:null,metadata:{code,name,wholesaleCents,minResaleCents,active},transaction:t});
    return record;
  });
}
export async function createStockOrder({sellerPartnerId,planCode,quantityMonths},actor) {
  adminActor(actor);
  return tx(async t=>{
    const seller=await activeSeller(sellerPartnerId,t,{locked:true});
    if(seller.parent_partner_id)fail(403,'BUY_FROM_PARENT','Submasters recebem estoque do Master responsável; compras diretas da plataforma são reservadas aos Masters raiz.');
    const plan=await planRow(planCode,t,{active:true});
    const agreed=await one(`SELECT unit_price_cents FROM partner_portal_seller_prices
      WHERE seller_partner_id=:sellerPartnerId AND plan_code=:planCode`,{sellerPartnerId,planCode},t);
    const unit=Number(agreed?.unit_price_cents??plan.wholesale_cents),total=safeTotal(unit,quantityMonths);
    const config=await one('SELECT default_gateway FROM partner_portal_payment_settings WHERE singleton_id=1',{},t);
    const gateway=config?.default_gateway||'manual';
    const row=await one(`INSERT INTO partner_portal_stock_orders(seller_partner_id,plan_code,quantity_months,unit_price_cents,total_cents,payment_gateway)
      VALUES (:sellerPartnerId,:planCode,:quantityMonths,:unit,:total,:gateway) RETURNING *`,
      {sellerPartnerId,planCode,quantityMonths,unit,total,gateway},t);
    await audit({actor,action:'portal.sales.stock.order',entityType:'portal_stock_order',entityId:row.id,metadata:{sellerPartnerId,planCode,quantityMonths,total,paid:false},transaction:t});
    return row;
  });
}
export async function settleStockOrder(orderId,{settlementRef,method},actor) {
  adminActor(actor);
  settlementRef=settlementRef.trim().toUpperCase();
  return tx(async t=>{
    const row=await one('SELECT * FROM partner_portal_stock_orders WHERE id=:orderId FOR UPDATE',{orderId},t);
    if(!row)throw notFound('Pedido de estoque do Painel do Parceiro');
    if(row.status==='paid') {
      if(row.settlement_ref===settlementRef)return {...row,idempotent:true};
      fail(409,'ORDER_ALREADY_SETTLED','Pedido já liquidado com outra referência.');
    }
    if(row.status!=='pending')fail(409,'ORDER_CLOSED','Pedido não pode ser liquidado.');
    if(row.payment_gateway!=='manual')fail(409,'GATEWAY_VERIFICATION_REQUIRED','Pedido criado com gateway automático: aguarde confirmação pela API do provedor. Não libere estoque por confirmação manual.');
    // Uma referência de pagamento bancário nunca financia dois pedidos (UNIQUE no banco).
    const buyer=await sellerRow(row.seller_partner_id,t,{locked:true});
    const newMasterPending=buyer.status==='suspended'&&
      (await one(`SELECT 1 AS pending FROM partner_portal_master_packages mp JOIN partners p ON p.id=mp.partner_id
       WHERE mp.partner_id=:id AND mp.first_order_id=:orderId AND mp.status='pending'
       AND p.status_reason='PENDING_PORTAL_MASTER_PAYMENT'`,{id:row.seller_partner_id,orderId},t));
    if(!buyer.active||buyer.status!=='active'&&!newMasterPending)
      fail(403,'MASTER_DISABLED','Master bloqueado: revise a conta antes de confirmar a cobrança.');
    const updated=await one(`UPDATE partner_portal_stock_orders SET status='paid',settlement_ref=:settlementRef,
      settlement_method=:method,approved_by=:actorId,settled_at=now() WHERE id=:orderId RETURNING *`,
      {orderId,settlementRef,method,actorId:actor.id},t);
    if(!row.service_access_only)await receiveStock(row.seller_partner_id,row.plan_code,row.quantity_months,t);
    await activateMasterPackageForPaidOrder(orderId,t);
    await audit({actor,action:'portal.sales.stock.paid',entityType:'portal_stock_order',entityId:orderId,metadata:{sellerPartnerId:row.seller_partner_id,planCode:row.plan_code,quantityMonths:row.quantity_months,totalCents:Number(row.total_cents),settlementRef,method,verifiedManually:true},transaction:t});
    return updated;
  });
}
/** Somente conferência API comprovada por checkout.service pode chamar este método.
 * Recheca identidade, valor e status sob o mesmo lock financeiro usado na confirmação manual.
 */
export async function settleVerifiedPortalOrder(orderId,{gateway,transactionNsu,slug=null,amountCents}) {
  if(!['infinitepay','mercadopago'].includes(gateway)||!transactionNsu||!slug&&gateway==='infinitepay')
    fail(422,'UNVERIFIED_PAYMENT','Identificação incompleta do pagamento.');
  return tx(async t=>{
    const order=await one('SELECT * FROM partner_portal_stock_orders WHERE id=:orderId FOR UPDATE',{orderId},t);
    if(!order)throw notFound('Pedido de acesso ao Painel do Parceiro');
    if(order.payment_gateway!==gateway)fail(409,'GATEWAY_MISMATCH','Pagamento recebido por outro meio.');
    if(!verifiedAmountMatches(order,amountCents))
      fail(409,'PAYMENT_AMOUNT_MISMATCH','O pagamento informado não coincide com o valor total do pedido. Conferência manual necessária.');
    if(order.status==='paid')return {...order,idempotent:true};
    if(order.status!=='pending')fail(409,'ORDER_CLOSED','Pagamento de pedido encerrado exige conferência manual, sem liberar estoque.');
    // Pedido foi criado quando o vendedor era ativo. Se ele for suspenso antes do pagamento,
    // não reter dinheiro sem reconhecimento: creditar meses ao estoque BLOQUEADO; activeSeller
    // continua impedindo seu uso até a reativação do vendedor.
    await sellerRow(order.seller_partner_id,t,{locked:true});
    const settlementRef=`${gateway}:${transactionNsu}`.slice(0,120);
    const updated=await one(`UPDATE partner_portal_stock_orders SET status='paid',settlement_ref=:settlementRef,
      settlement_method=:gateway,settled_at=now(),payment_verified_at=now(),
      payment_transaction_nsu=:transactionNsu,payment_slug=:slug
      WHERE id=:orderId RETURNING *`,{orderId,settlementRef,gateway,transactionNsu,slug},t);
    if(!order.service_access_only)await receiveStock(order.seller_partner_id,order.plan_code,order.quantity_months,t);
    await activateMasterPackageForPaidOrder(orderId,t);
    await audit({actor:{type:'system',role:'system'},action:'portal.sales.stock.payment_api_verified',
      entityType:'portal_stock_order',entityId:orderId,metadata:{gateway,orderId,amountCents,transactionNsu,verifiedByProvider:true,quantityMonths:order.quantity_months},transaction:t});
    return updated;
  });
}

export async function grantException({sellerPartnerId,planCode,quantityMonths,reason},actor) {
  adminActor(actor);
  return tx(async t=>{
    await activeSeller(sellerPartnerId,t,{locked:true});
    await planRow(planCode,t);
    const r=await one(`INSERT INTO partner_portal_stock_exceptions(seller_partner_id,plan_code,quantity_months,reason,approved_by)
      VALUES (:sellerPartnerId,:planCode,:quantityMonths,:reason,:actorId) RETURNING *`,
      {sellerPartnerId,planCode,quantityMonths,reason,actorId:actor.id},t);
    await receiveStock(sellerPartnerId,planCode,quantityMonths,t);
    await audit({actor,action:'portal.sales.stock.superadmin_exception',entityType:'portal_stock_exception',entityId:r.id,metadata:{sellerPartnerId,planCode,quantityMonths,reason,paymentVerified:false},transaction:t});
    return r;
  });
}
export async function transfer({sellerPartnerId,buyerPartnerId,planCode,quantityMonths,unitResaleCents,requestId},actor) {
  sellerActor(actor,sellerPartnerId);
  return tx(async t=>{
    // Identificador da requisição é único por vendedor. Lock da linha do vendedor serializa retries.
    const movingSeller=await activeSeller(sellerPartnerId,t,{locked:true});
    if(!movingSeller.can_transfer_stock)fail(403,'STOCK_TRANSFER_FORBIDDEN','O Master responsável não autorizou a transferência de estoque.');
    const existing=await one(`SELECT * FROM partner_portal_transfers WHERE seller_partner_id=:sellerPartnerId AND request_id=:requestId`,{sellerPartnerId,requestId},t);
    if(existing) {
      if(existing.buyer_partner_id!==buyerPartnerId||existing.plan_code!==planCode||existing.quantity_months!==quantityMonths||Number(existing.declared_unit_price_cents)!==unitResaleCents)
        fail(409,'IDEMPOTENCY_CONFLICT','Identificador reaproveitado com dados diferentes.');
      return {...existing,idempotent:true};
    }
    const buyer=await activeSeller(buyerPartnerId,t,{locked:true});
    if(buyer.parent_partner_id!==sellerPartnerId)fail(403,'OUTSIDE_NETWORK','Só é permitido transferir estoque ao Submaster diretamente vinculado.');
    const plan=await planRow(planCode,t,{active:true});
    if(!resaleAllowed(unitResaleCents,plan))fail(422,'BELOW_MINIMUM_PRICE','Preço declarado abaixo do piso comercial definido pelo Superadmin.');
    const total=safeTotal(unitResaleCents,quantityMonths);
    await spendStock(sellerPartnerId,planCode,quantityMonths,t);
    await receiveStock(buyerPartnerId,planCode,quantityMonths,t);
    const r=await one(`INSERT INTO partner_portal_transfers(seller_partner_id,buyer_partner_id,plan_code,quantity_months,
      declared_unit_price_cents,declared_total_cents,request_id,actor_user_id)
      VALUES (:sellerPartnerId,:buyerPartnerId,:planCode,:quantityMonths,:unitResaleCents,:total,:requestId,:actorId) RETURNING *`,
      {sellerPartnerId,buyerPartnerId,planCode,quantityMonths,unitResaleCents,total,requestId,actorId:actor.id},t);
    await audit({actor,action:'portal.sales.stock.transfer',entityType:'portal_stock_transfer',entityId:r.id,metadata:{sellerPartnerId,buyerPartnerId,planCode,quantityMonths,declaredTotalCents:total,paymentVerified:false},transaction:t});
    return r;
  });
}
/** Contrato inicial somente pelo Superadmin: não permite a um seller reivindicar qualquer parceiro por UUID.
 * Renovações podem ser feitas pelo dono do contrato mediante estoque pré-pago.
 */
export async function assignAccess({sellerPartnerId,customerPartnerId,planCode,months,unitResaleCents,monthlyFeeCents=0,requestId},actor,{admin=false}={}) {
  if(admin)adminActor(actor);else sellerActor(actor,sellerPartnerId);
  return tx(async t=>{
    await activeSeller(sellerPartnerId,t,{locked:true});
    const previous=await one(`SELECT * FROM partner_portal_contract_events WHERE seller_partner_id=:sellerPartnerId AND request_id=:requestId`,{sellerPartnerId,requestId},t);
    if(previous) {
      const previousContract=await one('SELECT * FROM partner_portal_access_contracts WHERE id=:id',{id:previous.contract_id},t);
      if(previousContract.customer_partner_id!==customerPartnerId||previous.plan_code!==planCode||previous.months!==months||Number(previous.declared_resale_cents)!==safeTotal(unitResaleCents,months)||Number(previousContract.monthly_fee_cents)!==monthlyFeeCents)
        fail(409,'IDEMPOTENCY_CONFLICT','Requisição repetida com conteúdo diferente.');
      return {contract:previousContract,event:previous,idempotent:true};
    }
    const customer=await one('SELECT id,name,kind,status,ends_at FROM partners WHERE id=:customerPartnerId FOR UPDATE',{customerPartnerId},t);
    if(!customer||!isContentPartner(customer.kind))fail(422,'NOT_CONTENT_PARTNER','Acesso comercial só pode ser aplicado a contas do Painel do Parceiro.');
    if(customer.status==='deleted'||customer.status==='cancelled')fail(409,'CUSTOMER_INACTIVE','Conta encerrada não pode receber contrato.');
    const current=await one('SELECT * FROM partner_portal_access_contracts WHERE customer_partner_id=:customerPartnerId FOR UPDATE',{customerPartnerId},t);
    if(!current&&!admin)fail(403,'INITIAL_ASSIGNMENT_ADMIN_ONLY','O primeiro vínculo de um cliente com a rede exige aprovação do Superadmin.');
    if(current&&(current.seller_partner_id!==sellerPartnerId||current.plan_code!==planCode))fail(409,'CONTRACT_OWNER_OR_PLAN','Contrato pertence a outra rede/plano. Transferência exige auditoria do Superadmin.');
    const plan=await planRow(planCode,t,{active:true});
    if(!resaleAllowed(unitResaleCents,plan))fail(422,'BELOW_MINIMUM_PRICE','Preço abaixo do piso comercial do plano.');
    const declaredTotal=safeTotal(unitResaleCents,months);
    const now=new Date();
    const legacyEnd=customer.ends_at&&new Date(customer.ends_at)>now?new Date(customer.ends_at):now;
    const before=current?new Date(current.expires_at):null;
    // Nunca consumir meses pagos sobre um prazo LEGADO ainda válido; os meses comprados começam
    // depois da expiração anterior. Sem contrato legado, contam imediatamente.
    const reference=current?(before&&before>now?before:now):legacyEnd;
    const startAt=current?new Date(current.start_at):reference;
    const expires=addMonthsUtc(reference,months);
    await spendStock(sellerPartnerId,planCode,months,t);
    let contract;
    if(current){
      // Mensalidade declarada só muda por aprovação explícita do Superadmin.
      if(monthlyFeeCents!==Number(current.monthly_fee_cents))fail(403,'MONTHLY_FEE_LOCKED','Alteração da mensalidade exige operação administrativa específica.');
      contract=await one(`UPDATE partner_portal_access_contracts SET expires_at=:expires,months_paid=months_paid+:months,
        declared_resale_cents=declared_resale_cents+:declaredTotal,updated_at=now() WHERE id=:id RETURNING *`,
        {expires,months,declaredTotal,id:current.id},t);
    }else {
      contract=await one(`INSERT INTO partner_portal_access_contracts(customer_partner_id,seller_partner_id,plan_code,start_at,expires_at,months_paid,declared_resale_cents,monthly_fee_cents,package_snapshot)
        VALUES (:customerPartnerId,:sellerPartnerId,:planCode,:startAt,:expires,:months,:declaredTotal,:monthlyFeeCents,CAST(:snapshot AS jsonb)) RETURNING *`,
        {customerPartnerId,sellerPartnerId,planCode,startAt,expires,months,declaredTotal,monthlyFeeCents,snapshot:JSON.stringify(packageSnapshot(plan))},t);
    }
    // Preserva prazo mais longo de parceiro legado: não reduz duração existente da conta.
    await run('UPDATE partners SET ends_at=GREATEST(ends_at,:expires) WHERE id=:customerPartnerId',{customerPartnerId,expires},t);
    const event=await one(`INSERT INTO partner_portal_contract_events(contract_id,seller_partner_id,request_id,months,plan_code,declared_resale_cents,previous_expires_at,expires_at,actor_user_id)
      VALUES (:contractId,:sellerPartnerId,:requestId,:months,:planCode,:declaredTotal,:before,:expires,:actorId) RETURNING *`,
      {contractId:contract.id,sellerPartnerId,requestId,months,planCode,declaredTotal,before,expires,actorId:actor.id},t);
    await audit({actor,action:'portal.sales.access.assign',entityType:'partner_portal_access_contract',entityId:contract.id,metadata:{customerPartnerId,sellerPartnerId,planCode,months,expires,declaredTotalCents:declaredTotal,monthlyFeeCents,paymentVerified:false,admin},transaction:t});
    return {contract,event};
  });
}
/** Contratos novos restringem o acesso ao painel quando vencidos; contas legadas sem registro continuam intactas. */
export async function contentPortalAccessGuard(partnerId) {
  const row=await one(`SELECT expires_at FROM partner_portal_access_contracts WHERE customer_partner_id=:partnerId`,{partnerId});
  if(row && new Date(row.expires_at).getTime()<=Date.now())fail(402,'PORTAL_ACCESS_EXPIRED','O contrato de acesso ao Painel do Parceiro expirou. Solicite renovação ao seu distribuidor.');
}

/** Busca de contas de conteúdo existentes para associação ADMINISTRATIVA.
 * Nunca exposta aos vendedores: evita descoberta de parceiros de outras redes.
 */
export async function adminCandidates(query='') {
  // Limita a busca na tabela de parceiros ANTES de consultar as tabelas comerciais;
  // erro por migração faltante é 503 acionável, não 500 genérico.
  const pattern=`%${String(query).replace(/[\\%_]/g,c=>'\\'+c)}%`;
  try {
    return await read(`WITH candidates AS (
       SELECT id,name,slug,kind,status,public_partner_number FROM partners
       WHERE kind IN ('content','both') AND status <> 'deleted'
         AND (:q = '' OR name ILIKE :pattern OR slug ILIKE :pattern)
       ORDER BY name,id LIMIT 50
     ) SELECT p.*,s.role AS seller_role,c.seller_partner_id AS contract_seller_id
       FROM candidates p LEFT JOIN partner_portal_sellers s ON s.partner_id=p.id
       LEFT JOIN partner_portal_access_contracts c ON c.customer_partner_id=p.id
       ORDER BY p.name,p.id`,{q:query,pattern});
  } catch(e) {
    if(postgresMigrationError(e))fail(503,'PORTAL_SALES_MIGRATION_REQUIRED',
      'Banco desatualizado na venda do Painel do Parceiro. Faça backup e execute npm run db:migrate no backend.');
    throw e;
  }
}

export async function costForecast() {
 const [settings,partners]=await Promise.all([
  one('SELECT * FROM partner_portal_cost_settings WHERE singleton_id=1'),
  one(`SELECT count(*)::int AS n FROM partners WHERE kind IN ('content','both') AND status='active'`),
 ]);
 const forecast=forecastMonthlyCost(settings,partners?.n||0);
 return {settings,...forecast};
}
export async function updateCosts(input,actor) {
  adminActor(actor);
 return tx(async t=>{
  const row=await one(`UPDATE partner_portal_cost_settings SET vps_monthly_cents=:vpsMonthlyCents,
    domain_annual_cents=:domainAnnualCents,other_monthly_cents=:otherMonthlyCents,
    proxy_cost_per_gb_cents=:proxyCostPerGbCents,forecast_proxy_gb_per_partner=:forecastProxyGbPerPartner,
    target_margin_bp=:targetMarginBp,tax_bp=:taxBp,reserve_bp=:reserveBp,updated_at=now()
    WHERE singleton_id=1 RETURNING *`,input,t);
  if(!row)throw notFound('Configurações de custo');
  await audit({actor,action:'portal.sales.cost.forecast.update',entityType:'portal_cost_settings',entityId:null,metadata:input,transaction:t});
  return row;
 });
}

/** Árvore comercial independente da rede de dispositivos/TVs.
 * A consulta por vendedor usa somente descendants de seu próprio nó.
 * O limite da consulta é proteção de renderização, NÃO quota de contas ou profundidade.
 */
export async function portalSalesTree({sellerPartnerId=null,actor}={}){
  if(sellerPartnerId)sellerActor(actor,sellerPartnerId);else adminActor(actor);
  return read(`WITH RECURSIVE tree AS (
     SELECT s.partner_id,s.parent_partner_id,s.role,s.active,s.can_sell,p.name,p.status,0::int AS depth,
       ARRAY[s.partner_id] AS path
     FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id
     WHERE (:sellerPartnerId IS NULL AND s.parent_partner_id IS NULL) OR s.partner_id=:sellerPartnerId
     UNION ALL
     SELECT c.partner_id,c.parent_partner_id,c.role,c.active,c.can_sell,p.name,p.status,tree.depth+1,
       tree.path||c.partner_id
     FROM tree JOIN partner_portal_sellers c ON c.parent_partner_id=tree.partner_id
     JOIN partners p ON p.id=c.partner_id
     WHERE NOT c.partner_id=ANY(tree.path)
   ) SELECT partner_id,parent_partner_id,role,active,can_sell,name,status,depth,
      (SELECT COALESCE(sum(st.available_months),0) FROM partner_portal_stock st
        WHERE st.seller_partner_id=tree.partner_id) AS available_months,
      (SELECT count(*)::int FROM partner_portal_access_contracts ac
        WHERE ac.seller_partner_id=tree.partner_id) AS direct_customers
     FROM tree ORDER BY path LIMIT 500`,{sellerPartnerId});
}
