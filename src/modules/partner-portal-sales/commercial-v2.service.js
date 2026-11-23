import crypto from 'node:crypto';
import {QueryTypes} from 'sequelize';
import {sequelize, AdminUser, Partner} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {encryptSecret,verifyPassword,hashPassword} from '../../shared/crypto.js';
import {getServicePlan} from '../service-plans/plan.service.js';
import {applyServicePackageToPartner} from '../service-packages/package.apply.js';
import {env} from '../../config/env.js';
import {packageSnapshot,personalizedPackage,PERMISSION_KEYS,permissionColumns,permissionsFromRow,canMoveUnder} from './commercial-v2.rules.js';

const fail=(status,code,message)=>{throw new AppError(status,code,message);};
const read=(sql,replacements={},t)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction:t});
const exec=(sql,replacements={},t)=>sequelize.query(sql,{replacements,transaction:t});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;
const tx=fn=>sequelize.transaction(async t=>{await exec('SELECT pg_advisory_xact_lock(99111712)',{},t);return fn(t);});
const admin=actor=>{if(actor?.role!=='superadmin'||actor?.type!=='admin')fail(403,'DELTATV_ONLY','Operação exclusiva da DeltaTV.');};
const own=(actor,id)=>{if(actor?.type!=='partner'||actor?.partnerId!==id||actor?.role!=='partner')fail(403,'NOT_YOUR_NETWORK','Você não tem acesso a esta rede.');};
const active=async(id,t)=>{
 const s=await one(`SELECT s.*,p.name,p.status FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id WHERE s.partner_id=:id`,{id},t);
 if(!s||!s.active||!s.can_sell||s.status!=='active')fail(403,'NETWORK_NOT_ACTIVE','Distribuidor não habilitado.');
 return s;
};
export async function packages(){
 return read(`SELECT code,name,wholesale_cents,min_resale_cents,active,revision,service_tier,max_dns,activation_limit,
  auto_failover,auto_priority,email_alerts,detailed_history FROM partner_portal_sales_plans ORDER BY created_at DESC`);
}
export async function saveServicePackage(p,actor){admin(actor);
 if(p.minResaleCents<p.wholesaleCents)fail(422,'PRICE_BELOW_COST','Preço de revenda menor que o preço de aquisição.');
 if(p.autoPriority&&!p.autoFailover)fail(422,'PRIORITY_NEEDS_FAILOVER','Prioridade automática requer failover ativo.');
 return tx(async t=>{
  const tier=await one('SELECT key,audience,active FROM service_plan_catalogs WHERE key=:key',{key:p.tier},t);
  if(!tier||!tier.active||!['content','both'].includes(tier.audience))fail(422,'BAD_PACKAGE_TIER','Escolha um modelo técnico ativo para parceiro.');
  const current=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:code FOR UPDATE',{code:p.code},t);
  const row=await one(`INSERT INTO partner_portal_sales_plans(code,name,wholesale_cents,min_resale_cents,active,service_tier,max_dns,
    activation_limit,auto_failover,auto_priority,email_alerts,detailed_history)
   VALUES(:code,:name,:wholesaleCents,:minResaleCents,:active,:tier,:maxDns,:activationLimit,
    :autoFailover,:autoPriority,:emailAlerts,:detailedHistory)
   ON CONFLICT(code) DO UPDATE SET name=excluded.name,wholesale_cents=excluded.wholesale_cents,
    min_resale_cents=excluded.min_resale_cents,active=excluded.active,service_tier=excluded.service_tier,
    max_dns=excluded.max_dns,activation_limit=excluded.activation_limit,auto_failover=excluded.auto_failover,
    auto_priority=excluded.auto_priority,email_alerts=excluded.email_alerts,detailed_history=excluded.detailed_history,
    revision=partner_portal_sales_plans.revision+1,updated_at=now() RETURNING *`,p,t);
  await audit({actor,action:'portal.service_package.saved',entityType:'portal_package',entityId:null,
    metadata:{code:p.code,revision:row.revision,previousRevision:current?.revision??null},transaction:t});
  return {package:packageSnapshot(row),wholesaleCents:Number(row.wholesale_cents),minResaleCents:Number(row.min_resale_cents)};
 });
}
export async function myPackage(id){
 const [partner,contract,masterPackage,technical,terms,assigned]=await Promise.all([
   one('SELECT name,public_partner_number,ends_at FROM partners WHERE id=:id',{id}),
   one(`SELECT c.*,p.name AS package_name,p.service_tier, seller.name AS seller_name
       FROM partner_portal_access_contracts c JOIN partner_portal_sales_plans p ON p.code=c.plan_code
       JOIN partners seller ON seller.id=c.seller_partner_id WHERE c.customer_partner_id=:id`,{id}),
   one(`SELECT mp.package_snapshot,mp.status,mp.monthly_fee_cents,sp.name AS package_name FROM partner_portal_master_packages mp
      JOIN partner_portal_sales_plans sp ON sp.code=mp.plan_code WHERE mp.partner_id=:id`,{id}),
   getServicePlan(id),
   one('SELECT mode,activation_limit,fixed_fee_cents FROM content_partner_terms WHERE partner_id=:id',{id}),
   one(`SELECT a.package_snapshot,p.name FROM partner_service_package_assignments a
     JOIN partner_portal_sales_plans p ON p.code=a.package_code WHERE a.partner_id=:id`,{id})
 ]);
 const usage=await one(`SELECT count(*)::int AS used FROM activations WHERE partner_id=:id AND status<>'revoked'`,{id});
 const pendingOrder=masterPackage?.status==='pending'?await one(`SELECT o.id,o.status,o.payment_gateway,o.total_cents,o.checkout_url
  FROM partner_portal_master_packages mp JOIN partner_portal_stock_orders o ON o.id=mp.first_order_id
  WHERE mp.partner_id=:id`,{id}):null;
 return {publicId:partner?.public_partner_number?String(partner.public_partner_number):null,
   name:partner?.name,package:assigned?.package_snapshot||contract?.package_snapshot||masterPackage?.package_snapshot||null,
   packageName:technical?.planName||'Plano de serviço',
   expiresAt:partner?.ends_at,pendingPayment:pendingOrder?{orderId:pendingOrder.id,status:pendingOrder.status,gateway:pendingOrder.payment_gateway,totalCents:Number(pendingOrder.total_cents),checkoutUrl:pendingOrder.checkout_url}:null,legacy:!(assigned?.package_snapshot||contract?.package_snapshot||masterPackage?.package_snapshot),
   masterPackageStatus:masterPackage?.status||null,
   monthlyFeeCents:contract ? Math.round(Number(contract.declared_resale_cents||0)/Math.max(1,Number(contract.months_paid||1))) : Number(terms?.fixed_fee_cents||0),
   feeRecipient:contract?.seller_name||'DeltaTV',
   dns:{limit:technical?.features?.maxServers??null,perCode:true},
   activations:{limit:terms?.mode==='fixed_limited'?Number(terms.activation_limit):null,used:Number(usage?.used||0)},
   features:technical?.features||null,
   note:masterPackage?.status==='pending'?'Aguardando confirmação da cobrança anterior.':'Recursos atuais do plano e contrato existentes.'};
}
async function effectiveNetworkState(id,t){
 const row=await one(`SELECT s.*,p.status,p.ends_at,mp.status AS package_status
  FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id
  LEFT JOIN partner_portal_master_packages mp ON mp.partner_id=s.partner_id
  WHERE s.partner_id=:id`,{id},t);
 if(!row)return {registered:false,role:null,enabled:false,permissions:{}};
 const ancestors=await one(`WITH RECURSIVE hierarchy AS (
   SELECT s.partner_id,s.parent_partner_id,s.active,
    (s.can_sell AND COALESCE(pc.can_resell_panel,false)) AS can_sell,
    (s.can_create_submasters AND COALESCE(pc.can_create_submasters,false)) AS can_create_submasters,
    s.can_transfer_stock,
    (s.can_view_finance AND COALESCE(pc.can_view_finance,false)) AS can_view_finance,
    (s.can_manage_gateways AND COALESCE(pc.can_manage_gateways,false)) AS can_manage_gateways,
    p.status,ARRAY[s.partner_id] AS path
   FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id
   LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
   LEFT JOIN service_plan_catalogs pc ON pc.key=COALESCE(sp.tier,
     CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)
   WHERE s.partner_id=:id
   UNION ALL
   SELECT s.partner_id,s.parent_partner_id,s.active,
    (s.can_sell AND COALESCE(pc.can_resell_panel,false)),
    (s.can_create_submasters AND COALESCE(pc.can_create_submasters,false)),
    s.can_transfer_stock,
    (s.can_view_finance AND COALESCE(pc.can_view_finance,false)),
    (s.can_manage_gateways AND COALESCE(pc.can_manage_gateways,false)),
    p.status,h.path||s.partner_id
   FROM hierarchy h JOIN partner_portal_sellers s ON s.partner_id=h.parent_partner_id
   JOIN partners p ON p.id=s.partner_id
   LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
   LEFT JOIN service_plan_catalogs pc ON pc.key=COALESCE(sp.tier,
     CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)
   WHERE NOT s.partner_id=ANY(h.path)
 ) SELECT bool_and(active AND can_sell AND status='active') AS healthy,
   count(*) FILTER(WHERE parent_partner_id IS NULL)::int AS roots,
   bool_and(can_create_submasters) AS can_create_submasters,
   bool_and(can_transfer_stock) AS can_transfer_stock,
   bool_and(can_view_finance) AS can_view_finance,
   bool_and(can_manage_gateways) AS can_manage_gateways
   FROM hierarchy`,{id},t);
 const enabled=Boolean(ancestors?.healthy)&&ancestors.roots===1&&row.status==='active'&&new Date(row.ends_at).getTime()>Date.now()&&row.package_status!=='pending';
 const permissions=enabled?{
  canSell:true,canCreateSubmasters:!!ancestors.can_create_submasters,
  canTransferStock:!!ancestors.can_transfer_stock,canViewFinance:!!ancestors.can_view_finance,
  canManageGateways:!!ancestors.can_manage_gateways
 }:Object.fromEntries(PERMISSION_KEYS.map(key=>[key,false]));
 return {registered:true,role:row.role,enabled,permissions};
}
export async function ownPermissions(id,t){return effectiveNetworkState(id,t);}
export async function updateChildPermissions({parentId,childId,input,actor,isAdmin=false}){
 if(isAdmin)admin(actor);else own(actor,parentId);
 return tx(async t=>{
  const parent=isAdmin?null:await active(parentId,t);
  const effectiveParent=isAdmin?null:await effectiveNetworkState(parentId,t);
  const child=await one('SELECT * FROM partner_portal_sellers WHERE partner_id=:childId FOR UPDATE',{childId},t);
  if(!child)fail(404,'SUBMASTER_MISSING','Submaster não encontrado.');
  if(!isAdmin&&child.parent_partner_id!==parentId)fail(403,'NOT_DIRECT_SUBMASTER','Somente seu Submaster direto pode receber permissões.');
  if(!isAdmin)for(const [name,value] of Object.entries(input)){
    if(value&&!effectiveParent?.permissions?.[name])fail(403,'PERMISSION_CANNOT_DELEGATE','Você não pode conceder uma permissão que não possui.');
  }
  const keys=Object.keys(input);if(!keys.length)fail(422,'NO_PERMISSION_CHANGE','Selecione uma permissão.');
  const patches=keys.map((key,i)=>`${permissionColumns[key]}=:value${i}`);
  const replacements={childId,...Object.fromEntries(keys.map((k,i)=>[`value${i}`,input[k]]))};
  const next=await one(`UPDATE partner_portal_sellers SET ${patches.join(',')},updated_at=now() WHERE partner_id=:childId RETURNING *`,replacements,t);
  await audit({actor,action:'portal.network.permissions.updated',entityType:'partner',entityId:childId,
    metadata:{changes:input,parentId:child.parent_partner_id},transaction:t});
  return {partnerId:childId,permissions:permissionsFromRow(next)};
 });
}
export async function requestReparent({subjectId,destinationId,actor}){
 const actorId=actor?.partnerId;if(actor?.type!=='partner'||![subjectId,destinationId].includes(actorId))
   fail(403,'RELOCATION_PARTICIPANTS_ONLY','Somente o Submaster ou o Master de destino pode pedir a transferência.');
 return tx(async t=>{
  const subject=await one('SELECT * FROM partner_portal_sellers WHERE partner_id=:id FOR UPDATE',{id:subjectId},t);
  if(!subject||subject.role!=='submaster')fail(422,'ONLY_SUBMASTERS','A transferência automática aceita apenas Submasters.');
  const destination=await active(destinationId,t);
  if(!(await effectiveNetworkState(destinationId,t)).permissions?.canCreateSubmasters)fail(403,'DESTINATION_PERMISSION','O destino não pode receber novos Submasters.');
  const descendants=await read(`WITH RECURSIVE d AS(
   SELECT partner_id,ARRAY[partner_id] AS path FROM partner_portal_sellers WHERE parent_partner_id=:id
   UNION ALL SELECT s.partner_id,d.path||s.partner_id FROM d JOIN partner_portal_sellers s ON s.parent_partner_id=d.partner_id
   WHERE NOT s.partner_id=ANY(d.path)
  ) SELECT partner_id FROM d`,{id:subjectId},t);
  if(!canMoveUnder({subjectId,destinationId,descendants:descendants.map(x=>x.partner_id)}))
    fail(409,'NETWORK_CYCLE','O destino faz parte da própria rede do Submaster.');
  const existing=await one(`SELECT id FROM partner_portal_reparent_requests WHERE subject_partner_id=:subjectId AND status='pending'`,{subjectId},t);
  if(existing)fail(409,'MOVE_ALREADY_PENDING','Já existe transferência pendente para este Submaster.');
  const row=await one(`INSERT INTO partner_portal_reparent_requests(subject_partner_id,destination_partner_id,requested_by)
   VALUES (:subjectId,:destinationId,:actorId) RETURNING *`,{subjectId,destinationId,actorId},t);
  await audit({actor,action:'portal.network.move.requested',entityType:'partner',entityId:subjectId,metadata:{destinationId,requestId:row.id},transaction:t});
  return row;
 });
}
export async function reparentRequests(id,{isAdmin=false}={}){
 return read(`SELECT r.*,s.name AS subject_name,d.name AS destination_name FROM partner_portal_reparent_requests r
  JOIN partners s ON s.id=r.subject_partner_id JOIN partners d ON d.id=r.destination_partner_id
  ${isAdmin?'':`WHERE r.subject_partner_id=:id OR r.destination_partner_id=:id`} ORDER BY r.created_at DESC LIMIT 100`,{id});
}
export async function decideReparent(requestId,accepted,actor){
 if(actor?.type!=='partner')fail(403,'PARTNER_REQUIRED','A transferência exige aprovação do participante.');
 return tx(async t=>{
  const request=await one(`SELECT * FROM partner_portal_reparent_requests WHERE id=:requestId FOR UPDATE`,{requestId},t);
  if(!request)fail(404,'MOVE_NOT_FOUND','Transferência não encontrada.');
  if(request.status!=='pending')fail(409,'MOVE_RESOLVED','Transferência já encerrada.');
  if(![request.subject_partner_id,request.destination_partner_id].includes(actor.partnerId)||actor.partnerId===request.requested_by)
   fail(403,'SECOND_PARTY_REQUIRED','A confirmação precisa partir da outra conta envolvida.');
  if(accepted){
   const subject=await one('SELECT * FROM partner_portal_sellers WHERE partner_id=:id FOR UPDATE',{id:request.subject_partner_id},t);
   const destination=await active(request.destination_partner_id,t);
   if(subject?.role!=='submaster'||!(await effectiveNetworkState(destination.partner_id,t)).permissions?.canCreateSubmasters)fail(409,'MOVE_NOT_ALLOWED','Submaster ou destino não autorizado.');
   const descendants=await read(`WITH RECURSIVE d AS(
    SELECT partner_id,ARRAY[partner_id] AS path FROM partner_portal_sellers WHERE parent_partner_id=:id
    UNION ALL SELECT s.partner_id,d.path||s.partner_id FROM d JOIN partner_portal_sellers s ON s.parent_partner_id=d.partner_id
     WHERE NOT s.partner_id=ANY(d.path)
   ) SELECT partner_id FROM d`,{id:subject.partner_id},t);
   if(!canMoveUnder({subjectId:subject.partner_id,destinationId:destination.partner_id,descendants:descendants.map(x=>x.partner_id)}))
    fail(409,'NETWORK_CYCLE','Destino inválido após mudança na hierarquia.');
   await exec(`UPDATE partner_portal_sellers SET parent_partner_id=:destination,updated_at=now() WHERE partner_id=:subject`,
    {destination:destination.partner_id,subject:subject.partner_id},t);
   // Historical contract events/old payments still belong to previous seller. Future renewal belongs to new parent.
   await exec(`UPDATE partner_portal_access_contracts SET seller_partner_id=:destination,updated_at=now()
    WHERE customer_partner_id=:subject`,{destination:destination.partner_id,subject:subject.partner_id},t);
  }
  await exec(`UPDATE partner_portal_reparent_requests SET status=:status,reviewed_at=now() WHERE id=:requestId`,
   {status:accepted?'accepted':'rejected',requestId},t);
  await audit({actor,action:accepted?'portal.network.move.accepted':'portal.network.move.rejected',entityType:'partner',entityId:request.subject_partner_id,
   metadata:{destinationId:request.destination_partner_id,requestId},transaction:t});
  return {ok:true,status:accepted?'accepted':'rejected'};
 });
}
export async function adminReceivables(){
 return read(`SELECT o.id,o.seller_partner_id,p.name AS master_name,o.plan_code,pl.name AS package_name,
  o.quantity_months,o.unit_price_cents,o.total_cents,o.status,o.payment_gateway,o.settlement_method,
  o.settlement_ref,o.created_at,o.settled_at,o.checkout_url
 FROM partner_portal_stock_orders o JOIN partner_portal_sellers s ON s.partner_id=o.seller_partner_id
 JOIN partners p ON p.id=o.seller_partner_id JOIN partner_portal_sales_plans pl ON pl.code=o.plan_code
 WHERE s.parent_partner_id IS NULL ORDER BY o.created_at DESC LIMIT 300`);
}
export async function sellerGatewayStatus(id){
 const [seller,rows]=await Promise.all([ownPermissions(id),read(`SELECT provider,account_ref,active,updated_at
  FROM partner_portal_seller_gateways WHERE partner_id=:id ORDER BY provider`,{id})]);
 if(!seller.registered||!seller.permissions.canManageGateways)fail(403,'GATEWAY_NOT_ALLOWED','Gateway não autorizado para sua conta.');
 const selected=await one('SELECT default_gateway FROM partner_portal_sellers WHERE partner_id=:id',{id});
 return {defaultGateway:selected?.default_gateway,providers:rows,webhookUrls:{
   mercadopago:`${env.publicBaseUrl}/api/v1/webhooks/portal-sales/resale/mercadopago/${id}`,
   infinitepay:`${env.publicBaseUrl}/api/v1/webhooks/portal-sales/resale/infinitepay/${id}`}};
}
export async function saveSellerGateway(id,{provider,accessToken,handle,webhookSecret,currentPassword},actor){
 own(actor,id);
 const perms=await ownPermissions(id);
 if(!perms.permissions.canManageGateways)fail(403,'GATEWAY_NOT_ALLOWED','Gateway não autorizado.');
 const author=await AdminUser.findByPk(actor.id);
 if(!author||!await verifyPassword(currentPassword,author.passwordHash))fail(403,'PASSWORD_CONFIRMATION_REQUIRED','Confirme a senha da sua conta.');
 let accountRef=handle||null;
 if(provider==='mercadopago'&&!accessToken)fail(422,'GATEWAY_INVALID','Informe o Access Token do Mercado Pago.');
 if(provider==='mercadopago'){
  let res;try{res=await fetch('https://api.mercadopago.com/users/me',{
    headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(12000)});}catch{fail(502,'GATEWAY_UNREACHABLE','Não foi possível verificar o Mercado Pago.');}
  if(!res.ok)fail(422,'GATEWAY_INVALID','A credencial do Mercado Pago não foi aceita.');
  const merchant=await res.json();accountRef=String(merchant.id||'');
  if(!/^\d{1,20}$/.test(accountRef))fail(502,'GATEWAY_INVALID_ACCOUNT','Conta de recebimento inválida.');
 }
 if(provider==='infinitepay'&&!/^[A-Za-z0-9._-]{2,120}$/.test(handle||''))fail(422,'INVALID_HANDLE','Informe sua InfiniteTag válida.');
 return tx(async t=>{
  const seller=await active(id,t);
  if(!(await effectiveNetworkState(id,t)).permissions?.canManageGateways)fail(403,'GATEWAY_NOT_ALLOWED','Gateway não autorizado.');
  await exec(`INSERT INTO partner_portal_seller_gateways(partner_id,provider,credentials_enc,account_ref,active)
    VALUES (:id,:provider,:secret,:account,true)
    ON CONFLICT(partner_id,provider) DO UPDATE SET credentials_enc=excluded.credentials_enc,
    account_ref=excluded.account_ref,active=true,updated_at=now()`,
   {id,provider,secret:encryptSecret(JSON.stringify({accessToken:accessToken||'',webhookSecret:webhookSecret||''})),account:accountRef},t);
  await audit({actor,action:'portal.network.gateway.configured',entityType:'partner',entityId:id,
   metadata:{provider,accountRef,confirmedOwner:provider==='mercadopago'},transaction:t});
  return {provider,accountRef,configured:true,warning:provider==='infinitepay'?'Credencial salva, mas ainda não validada em cobrança real.':null};
 });
}
export async function setSellerDefaultGateway(id,provider,actor){own(actor,id);
 return tx(async t=>{
  const seller=await active(id,t);const effective=await effectiveNetworkState(id,t);if(!effective.permissions?.canManageGateways)fail(403,'GATEWAY_NOT_ALLOWED','Gateway não autorizado.');
  const found=await one(`SELECT 1 FROM partner_portal_seller_gateways WHERE partner_id=:id AND provider=:provider AND active=true`,{id,provider},t);
  if(!found)fail(409,'GATEWAY_NOT_CONFIGURED','Configure o gateway antes de selecioná-lo.');
  await exec(`UPDATE partner_portal_sellers SET default_gateway=:provider,updated_at=now() WHERE partner_id=:id`,{id,provider},t);
  await audit({actor,action:'portal.network.gateway.default',entityType:'partner',entityId:id,metadata:{provider},transaction:t});
  return {defaultGateway:provider};
 });
}

export async function agreedMasterPrices(){
 return read(`SELECT sp.*,p.name AS master_name,pl.name AS package_name FROM partner_portal_seller_prices sp
 JOIN partners p ON p.id=sp.seller_partner_id JOIN partner_portal_sales_plans pl ON pl.code=sp.plan_code
 ORDER BY p.name,pl.name`);
}
export async function setAgreedMasterPrice({sellerId,planCode,unitPriceCents,reason},actor){admin(actor);
 if(!reason?.trim()||reason.trim().length<8)fail(422,'PRICE_REASON_REQUIRED','Justifique a negociação em pelo menos 8 caracteres.');
 return tx(async t=>{
  const seller=await active(sellerId,t);
  if(seller.parent_partner_id)fail(422,'ONLY_ROOT_MASTER','O preço negociado com a DeltaTV é exclusivo dos Masters diretos.');
  const plan=await one('SELECT code FROM partner_portal_sales_plans WHERE code=:planCode',{planCode},t);
  if(!plan)fail(404,'PACKAGE_NOT_FOUND','Pacote não encontrado.');
  const result=await one(`INSERT INTO partner_portal_seller_prices(seller_partner_id,plan_code,unit_price_cents,agreed_by)
   VALUES (:sellerId,:planCode,:unitPriceCents,:actorId)
   ON CONFLICT(seller_partner_id,plan_code) DO UPDATE SET unit_price_cents=excluded.unit_price_cents,
   agreed_at=now(),agreed_by=excluded.agreed_by RETURNING *`,{sellerId,planCode,unitPriceCents,actorId:actor.id},t);
  await audit({actor,action:'portal.network.price.negotiated',entityType:'partner',entityId:sellerId,
   metadata:{planCode,unitPriceCents,reason},transaction:t});
  return result;
 });
}

const codeHash=code=>crypto.createHash('sha256').update(String(code)).digest('hex');
export async function createReparentCode(actor){
 if(actor?.type!=='partner')fail(403,'PARTNER_REQUIRED','Acesso negado.');
 const code=crypto.randomBytes(18).toString('base64url');
 const record=await tx(async t=>{
  const subject=await active(actor.partnerId,t);
  if(subject.role!=='submaster')fail(422,'SUBMASTER_ONLY','Somente um Submaster pode solicitar transferência de rede.');
  await exec(`DELETE FROM partner_portal_reparent_codes WHERE subject_partner_id=:id AND used_at IS NULL`,{id:actor.partnerId},t);
  return one(`INSERT INTO partner_portal_reparent_codes(token_hash,subject_partner_id,expires_at)
   VALUES (:hash,:id,now()+interval '48 hours') RETURNING expires_at`,{hash:codeHash(code),id:actor.partnerId},t);
 });
 return {code,expiresAt:record.expires_at,warning:'Envie este código apenas ao Master que você deseja autorizar.'};
}
export async function requestReparentByCode(code,actor){
 if(actor?.type!=='partner')fail(403,'PARTNER_REQUIRED','Acesso negado.');
 return tx(async t=>{
  const destination=await active(actor.partnerId,t);
  if(!(await effectiveNetworkState(actor.partnerId,t)).permissions?.canCreateSubmasters)fail(403,'DESTINATION_PERMISSION','Sua conta não pode receber Submasters.');
  const entry=await one(`SELECT * FROM partner_portal_reparent_codes WHERE token_hash=:hash
   AND used_at IS NULL AND expires_at>now() FOR UPDATE`,{hash:codeHash(code)},t);
  if(!entry)fail(400,'TRANSFER_CODE_INVALID','Código inválido, usado ou vencido.');
  const subject=await one(`SELECT * FROM partner_portal_sellers WHERE partner_id=:id`,{id:entry.subject_partner_id},t);
  if(subject?.role!=='submaster'||subject.partner_id===destination.partner_id)fail(409,'TRANSFER_UNAVAILABLE','Submaster não pode ser transferido.');
  const descendants=await read(`WITH RECURSIVE d AS(SELECT partner_id,ARRAY[partner_id] AS path FROM partner_portal_sellers WHERE parent_partner_id=:id
   UNION ALL SELECT s.partner_id,d.path||s.partner_id FROM d JOIN partner_portal_sellers s ON s.parent_partner_id=d.partner_id
   WHERE NOT s.partner_id=ANY(d.path)) SELECT partner_id FROM d`,{id:subject.partner_id},t);
  if(!canMoveUnder({subjectId:subject.partner_id,destinationId:destination.partner_id,descendants:descendants.map(x=>x.partner_id)}))
    fail(409,'NETWORK_CYCLE','Não é permitido transferir para a própria rede descendente.');
  const pending=await one(`SELECT 1 FROM partner_portal_reparent_requests WHERE subject_partner_id=:id AND status='pending'`,{id:subject.partner_id},t);
  if(pending)fail(409,'TRANSFER_PENDING','Já existe uma solicitação pendente para este Submaster.');
  const request=await one(`INSERT INTO partner_portal_reparent_requests(subject_partner_id,destination_partner_id,requested_by)
    VALUES(:subject,:dest,:dest) RETURNING *`,{subject:subject.partner_id,dest:destination.partner_id},t);
  await exec('UPDATE partner_portal_reparent_codes SET used_at=now() WHERE token_hash=:hash',{hash:codeHash(code)},t);
  await audit({actor,action:'portal.network.move.code_requested',entityType:'partner',entityId:subject.partner_id,
    metadata:{destinationId:destination.partner_id,requestId:request.id},transaction:t});
  return {requestId:request.id,status:'pending'};
 });
}

/** Aplica benefícios com o mesmo contrato técnico que os parceiros existentes usam.
 * Não emite estoque nem afeta licenças de TV. Executado somente em transações autorizadas.
 */
async function applyMasterBenefits(partnerId,snapshot,fee,t){
 await applyServicePackageToPartner(partnerId,snapshot,t,{recordAssignment:true,monthlyFeeCents:fee});
 const {invalidatePlan}=await import('../service-plans/plan.service.js');invalidatePlan(partnerId);
}

/** Cadastro realmente unificado: conta nova OU existente, pacote, ativações e permissões.
 * A DeltaTV pode conceder o acesso sem cobrança; nesse caso NÃO cria estoque de revenda.
 */
export async function onboardMasterSimple({account,planCode,activationLimit,permissions,free=true,
 quantityMonths=12,agreedPriceCents,paymentMode='default'},actor){
 admin(actor);
 const hashed=account.mode==='new'?await hashPassword(account.password):null;
 return tx(async t=>{
  const plan=await one(`SELECT p.*,c.max_apps FROM partner_portal_sales_plans p LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier WHERE p.code=:planCode AND p.active=true`,{planCode},t);
  let snapshot;
  try{snapshot=personalizedPackage(plan,activationLimit);}catch(e){fail(422,'PACKAGE_LIMIT_INVALID',e.message);}
  let partnerId,createdUserId=null;
  if(account.mode==='existing'){
   const partner=await one(`SELECT id,kind,status FROM partners WHERE id=:id FOR UPDATE`,{id:account.partnerId},t);
   if(!partner||!['content','both'].includes(partner.kind)||partner.status!=='active')
    fail(422,'INVALID_PARTNER','Selecione uma conta ativa do Painel do Parceiro.');
   partnerId=partner.id;
  }else{
   const email=account.email.trim().toLowerCase();
   const taken=await one(`SELECT id FROM admin_users WHERE lower(email)=:email
     UNION ALL SELECT id FROM partners WHERE lower(contact_email)=:email AND status<>'deleted' LIMIT 1`,{email},t);
   if(taken)fail(409,'MASTER_EMAIL_TAKEN','Este e-mail já pertence a uma conta. Selecione a conta existente.');
   const now=new Date();const expires=new Date(now);
   expires.setUTCMonth(expires.getUTCMonth()+quantityMonths);
   const created=await Partner.create({name:account.companyName.trim(),slug:`parceiro-${crypto.randomBytes(7).toString('hex')}`,
     contactName:account.name.trim(),contactEmail:email,kind:'content',billingModel:'none',
     status:free?'active':'suspended',statusReason:free?null:'PENDING_PORTAL_MASTER_PAYMENT',startsAt:now,endsAt:expires}, {transaction:t});
   partnerId=created.id;
   const user=await AdminUser.create({name:account.name.trim(),email,passwordHash:hashed,
    role:'partner',partnerId,status:'active'}, {transaction:t});
   createdUserId=user.id;
  }
  const existing=await one('SELECT partner_id FROM partner_portal_sellers WHERE partner_id=:id',{id:partnerId},t);
  if(existing)fail(409,'MASTER_ALREADY_EXISTS','A conta já participa da rede. Edite as permissões no perfil.');
  if(snapshot.maxDns!==null){
   const exceeding=await one(`SELECT c.code,count(pool.id)::int AS count FROM partner_codes c
     JOIN code_server_pools pool ON pool.code_id=c.id WHERE c.partner_id=:id AND c.status='active'
     GROUP BY c.id,c.code HAVING count(pool.id)>:dns LIMIT 1`,{id:partnerId,dns:snapshot.maxDns},t);
   if(exceeding)fail(409,'MASTER_DNS_EXCEEDS_PACKAGE',`O código ${exceeding.code} possui mais DNS do que o pacote.`);
  }
  const values=Object.fromEntries(PERMISSION_KEYS.map(key=>[key,Boolean(permissions[key])]));
  await exec(`INSERT INTO partner_portal_sellers(partner_id,parent_partner_id,role,can_sell,active,
    can_create_submasters,can_transfer_stock,can_view_finance,can_manage_gateways)
    VALUES(:id,NULL,'master',:canSell,true,:canCreateSubmasters,:canTransferStock,:canViewFinance,:canManageGateways)`,
    {id:partnerId,...values},t);
  let order=null;
  if(!free){
   if(!Number.isSafeInteger(agreedPriceCents)||agreedPriceCents<1)
    fail(422,'MASTER_PRICE_REQUIRED','Informe o preço negociado para gerar a cobrança.');
   const total=agreedPriceCents*quantityMonths;
   if(!Number.isSafeInteger(total)||total>1_000_000_000_000)fail(422,'ORDER_TOTAL_INVALID','Total fora do limite.');
   const payment=await one('SELECT default_gateway FROM partner_portal_payment_settings WHERE singleton_id=1',{},t);
   const gateway=paymentMode==='manual'?'manual':payment?.default_gateway||'manual';
   await exec(`INSERT INTO partner_portal_seller_prices(seller_partner_id,plan_code,unit_price_cents,agreed_by)
     VALUES(:id,:planCode,:agreedPriceCents,:actorId)`,{id:partnerId,planCode,agreedPriceCents,actorId:actor.id},t);
   order=await one(`INSERT INTO partner_portal_stock_orders
     (seller_partner_id,plan_code,quantity_months,unit_price_cents,total_cents,payment_gateway,service_access_only)
     VALUES(:id,:planCode,:quantityMonths,:agreedPriceCents,:total,:gateway,true) RETURNING *`,
     {id:partnerId,planCode,quantityMonths,agreedPriceCents,total,gateway},t);
  }
  await exec(`INSERT INTO partner_portal_master_packages
    (partner_id,plan_code,package_snapshot,first_order_id,created_user_id,monthly_fee_cents,status,activated_at)
    VALUES(:id,:planCode,CAST(:snapshot AS jsonb),:orderId,:createdUserId,0,:status,:activatedAt)`,
    {id:partnerId,planCode,snapshot:JSON.stringify(snapshot),orderId:order?.id||null,createdUserId,
     status:free?'active':'pending',activatedAt:free?new Date():null},t);
  if(free)await applyMasterBenefits(partnerId,snapshot,0,t);
  await audit({actor,action:free?'portal.master.granted_without_charge':'portal.master.quick_purchase_created',
   entityType:'partner',entityId:partnerId,metadata:{planCode,activationLimit:snapshot.activationLimit,
    dns:snapshot.maxDns,permissions:values,quantityMonths,accountCreated:account.mode==='new',
    firstOrderId:order?.id||null,free,stockGranted:0},transaction:t});
  return {partnerId,orderId:order?.id||null,free,accountCreated:account.mode==='new',
   paymentPending:!free,benefitsActive:free,stockAvailable:0};
 });
}

/** Cadastro comercial de Master raiz em uma só operação: pacote + preço negociado + pedido.
 * Não provisiona benefícios nem emite meses antes da confirmação financeira.
 */
export async function onboardRootMaster({partnerId,planCode,quantityMonths,agreedPriceCents,monthlyFeeCents=0,paymentMode='default'},actor){admin(actor);
 if(!Number.isSafeInteger(quantityMonths)||quantityMonths<1||!Number.isSafeInteger(agreedPriceCents)||agreedPriceCents<1)
  fail(422,'INVALID_MASTER_PURCHASE','Informe quantidade e valor negociado válidos.');
 return tx(async t=>{
  const partner=await one(`SELECT id,name,kind,status FROM partners WHERE id=:partnerId FOR UPDATE`,{partnerId},t);
  if(!partner||!['content','both'].includes(partner.kind)||partner.status!=='active')
   fail(422,'INVALID_PARTNER','Selecione um parceiro ativo do Painel do Parceiro.');
  const exists=await one('SELECT partner_id FROM partner_portal_sellers WHERE partner_id=:partnerId',{partnerId},t);
  if(exists)fail(409,'MASTER_ALREADY_EXISTS','Conta já é Master/Submaster. Edite os preços e pedidos existentes.');
  const plan=await one(`SELECT p.*,c.max_apps FROM partner_portal_sales_plans p LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier WHERE p.code=:planCode AND p.active=true`,{planCode},t);
  const snapshot=packageSnapshot(plan);
  if(!snapshot)fail(409,'PACKAGE_NOT_CONFIGURED','Escolha um Pacote de Serviço válido, não um plano comercial legado.');
  const total=agreedPriceCents*quantityMonths;
  if(!Number.isSafeInteger(total)||total>1_000_000_000_000)fail(422,'ORDER_TOTAL_INVALID','Total fora dos limites de segurança.');
  // Validação de limite antes de emitir a cobrança. A plataforma não remove DNS existentes.
  if(snapshot.maxDns!==null){
   const exceeding=await one(`SELECT c.code,count(pool.id)::int AS count FROM partner_codes c
      JOIN code_server_pools pool ON pool.code_id=c.id WHERE c.partner_id=:partnerId AND c.status='active'
      GROUP BY c.id,c.code HAVING count(pool.id) > :maxDns LIMIT 1`,{partnerId,maxDns:snapshot.maxDns},t);
   if(exceeding)fail(409,'MASTER_DNS_EXCEEDS_PACKAGE',`O código ${exceeding.code} já possui ${exceeding.count} DNS. Selecione pacote compatível.`);
  }
  await exec(`INSERT INTO partner_portal_sellers(partner_id,parent_partner_id,role,can_sell,active,
    can_create_submasters,can_transfer_stock,can_view_finance,can_manage_gateways)
    VALUES (:partnerId,NULL,'master',true,true,true,true,true,true)`,{partnerId},t);
  await exec(`INSERT INTO partner_portal_seller_prices(seller_partner_id,plan_code,unit_price_cents,agreed_by)
    VALUES(:partnerId,:planCode,:agreedPriceCents,:actorId)`,{partnerId,planCode,agreedPriceCents,actorId:actor.id},t);
  const settings=await one('SELECT default_gateway FROM partner_portal_payment_settings WHERE singleton_id=1',{},t);
  const gateway=paymentMode==='manual'?'manual':settings?.default_gateway||'manual';
  const order=await one(`INSERT INTO partner_portal_stock_orders
    (seller_partner_id,plan_code,quantity_months,unit_price_cents,total_cents,payment_gateway,service_access_only)
    VALUES (:partnerId,:planCode,:quantityMonths,:agreedPriceCents,:total,:gateway,true) RETURNING *`,
    {partnerId,planCode,quantityMonths,agreedPriceCents,total,gateway},t);
  await exec(`INSERT INTO partner_portal_master_packages
    (partner_id,plan_code,package_snapshot,first_order_id,monthly_fee_cents,status)
    VALUES(:partnerId,:planCode,CAST(:snapshot AS jsonb),:firstOrderId,:monthlyFeeCents,'pending')`,
    {partnerId,planCode,snapshot:JSON.stringify(snapshot),firstOrderId:order.id,monthlyFeeCents},t);
  await audit({actor,action:'portal.master.onboard.requested',entityType:'partner',entityId:partnerId,
    metadata:{planCode,agreedPriceCents,quantityMonths,monthlyFeeCents,orderId:order.id,status:'pending_payment'},transaction:t});
  return {partnerId,order,paymentPending:true,benefitsPending:true};
 });
}

/** Chamado exclusivamente dentro de liquidação de estoque verificada, na mesma transação. */
export async function activateMasterPackageForPaidOrder(orderId,t){
 const row=await one(`SELECT mp.*,o.status AS order_status FROM partner_portal_master_packages mp
 JOIN partner_portal_stock_orders o ON o.id=mp.first_order_id WHERE mp.first_order_id=:orderId FOR UPDATE OF mp`,{orderId},t);
 if(!row||row.status==='active'||row.order_status!=='paid')return;
 const snapshot=row.package_snapshot;
 // Se alguém adicionou DNS entre o cadastro e o pagamento, não cortamos a operação existente.
 if(snapshot.maxDns!==null){const exceeding=await one(`SELECT c.code FROM partner_codes c
 JOIN code_server_pools pool ON pool.code_id=c.id WHERE c.partner_id=:partnerId AND c.status='active'
 GROUP BY c.id,c.code HAVING count(pool.id) > :dns LIMIT 1`,{partnerId:row.partner_id,dns:snapshot.maxDns},t);
 if(exceeding){await exec(`UPDATE partner_portal_master_packages SET status='pending_review',updated_at=now()
 WHERE partner_id=:partnerId`,{partnerId:row.partner_id},t);return;}
 }
 await applyMasterBenefits(row.partner_id,snapshot,row.monthly_fee_cents,t);
 const duration=await one('SELECT quantity_months FROM partner_portal_stock_orders WHERE id=:orderId',{orderId},t);
 if(row.created_user_id){
  await exec(`UPDATE partners SET starts_at=now(),ends_at=now() + make_interval(months => :months),
    status='active',status_reason=NULL
    WHERE id=:id AND status='suspended' AND status_reason='PENDING_PORTAL_MASTER_PAYMENT'`,
    {id:row.partner_id,months:duration.quantity_months},t);
 }else{
  // Existing account: extend the paid period once on activation, rather than leaving its old expiry.
  await exec(`UPDATE partners SET ends_at=GREATEST(ends_at,now()) + make_interval(months => :months)
     WHERE id=:id AND status='active'`,{id:row.partner_id,months:duration.quantity_months},t);
 }
 await exec(`UPDATE partner_portal_master_packages SET status='active',activated_at=now(),updated_at=now()
 WHERE partner_id=:id`,{id:row.partner_id},t);
 // getServicePlan() cache expira em 20 segundos. A ativação online deve invalidar agora.
 const {invalidatePlan}=await import('../service-plans/plan.service.js');invalidatePlan(row.partner_id);
}

export async function pendingMasterOrderId(partnerId){
 const row=await one(`SELECT o.id FROM partner_portal_master_packages mp
 JOIN partner_portal_stock_orders o ON o.id=mp.first_order_id
 WHERE mp.partner_id=:partnerId AND mp.status='pending' AND o.status='pending'`,{partnerId});
 if(!row)fail(404,'NO_PENDING_MASTER_ORDER','Não existe cobrança pendente para seu acesso.');
 return row.id;
}
