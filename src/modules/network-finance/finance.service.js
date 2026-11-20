import { randomUUID } from 'node:crypto';
import { QueryTypes, Op } from 'sequelize';
import { sequelize, Partner, AdminUser, PartnerServicePlan, ServicePlanCatalog, ContentPartnerTerms, Activation } from '../../db/models/index.js';
import { encryptSecret, decryptSecret } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { clearContractAccessCache } from '../access/access.service.js';
import { invalidatePlan } from '../service-plans/plan.service.js';
import { createMercadoPago, verifySignature } from '../pix/providers/mercadopago.js';
import { createInfinitePay, HANDLE_RE, normalizeHandle } from '../distribution/gateways/infinitepay.js';
import { canActivateGateway, csvSafe, fingerprint, maskAccountRef } from './policy.js';
import { env } from '../../config/env.js';

const fail = (status,code,message) => {throw new AppError(status,code,message)};
const query = (sql, params={},transaction) => sequelize.query(sql, {type:QueryTypes.SELECT,replacements:params,...(transaction?{transaction}:{})});
const asOwner = id => id || '00000000-0000-0000-0000-000000000000';
const GATEWAY_COLS='admin_user_id,provider,credentials_enc,webhook_secret_enc,account_ref,credential_fingerprint,tested_fingerprint,tested_at,active';
const rowFor = async (adminId,provider,transaction) => (await query(`SELECT ${GATEWAY_COLS} FROM admin_network_gateways WHERE admin_user_id=CAST(:adminId AS uuid) AND provider=:provider`,{adminId,provider},transaction))[0];
const noSecret = row => ({provider:row.provider,configured:true,active:row.active,tested:canActivateGateway(row),accountRefMasked:maskAccountRef(row.account_ref),testedAt:row.tested_at});
const owned = async (adminId,id,transaction) => {
  const p = await Partner.findOne({where:{id,ownerAdminId:adminId},transaction});
  if(!p || p.status==='deleted') fail(404,'NOT_FOUND','Parceiro não encontrado nesta rede.');
  return p;
};

export async function listGateways(adminId) {
  const rows=await query(`SELECT ${GATEWAY_COLS} FROM admin_network_gateways WHERE admin_user_id=CAST(:adminId AS uuid)`,{adminId});
  return ['mercadopago','infinitepay'].map(provider=> {
    const row=rows.find(r=>r.provider===provider);
    return row?noSecret(row):{provider,configured:false,active:false,tested:false,accountRefMasked:null,testedAt:null};
  });
}

async function gatewayPendingCount(adminId,provider,t) {
  const [r]=await query(`SELECT count(*)::int AS total FROM admin_network_charges WHERE owner_admin_id=CAST(:adminId AS uuid)
    AND provider=:provider AND status IN ('creating','pending')`,{adminId,provider},t);
  return Number(r?.total||0);
}

/** Salva credenciais em AES-GCM, SEM ativar. Alterações bloqueadas enquanto há cobrança aberta. */
export async function saveGateway(adminId,provider,input,actor) {
  const credential=provider==='mercadopago'?input.accessToken:input.apiKey;
  const accountRef=provider==='mercadopago'?'pending':normalizeHandle(input.handle);
  if(provider==='infinitepay'&&(!HANDLE_RE.test(accountRef)||!/^inchk_[\w-]{8,200}$/.test(credential||'')))
    fail(422,'INVALID_GATEWAY_CREDENTIALS','Informe handle e API Key válida (inchk_) da InfinitePay.');
  if(provider==='mercadopago'&&(!/^APP_USR-[\w-]{10,}$/.test(credential||'')||!input.webhookSecret?.trim()))
    fail(422,'INVALID_GATEWAY_CREDENTIALS','Informe o Access Token de produção e o segredo da assinatura do webhook.');
  return sequelize.transaction(async t=>{
    // Serializa escolhas e atualização de credenciais entre dois workers.
    await query('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
    if(await gatewayPendingCount(adminId,provider,t))
      fail(409,'GATEWAY_HAS_PENDING_CHARGES','Há cobranças abertas neste provedor. Preserve as credenciais até serem resolvidas.');
    const fp=fingerprint({provider,credential,secret:input.webhookSecret||'',accountRef});
    await query(`INSERT INTO admin_network_gateways(admin_user_id,provider,credentials_enc,webhook_secret_enc,account_ref,credential_fingerprint)
      VALUES(CAST(:adminId AS uuid),:provider,:cred,:secret,:accountRef,:fp)
      ON CONFLICT(admin_user_id,provider) DO UPDATE SET credentials_enc=EXCLUDED.credentials_enc,
      webhook_secret_enc=EXCLUDED.webhook_secret_enc,account_ref=EXCLUDED.account_ref,credential_fingerprint=EXCLUDED.credential_fingerprint,
      tested_at=NULL,tested_fingerprint=NULL,active=false,updated_at=now()`,
      {adminId,provider,cred:encryptSecret(credential),secret:input.webhookSecret?encryptSecret(input.webhookSecret):null,accountRef,fp},t);
    await audit({actor,action:'network.finance.gateway.configure',entityType:'admin_user',entityId:adminId,metadata:{provider},transaction:t});
    return {provider,configured:true,active:false,tested:false};
  });
}

/** A InfinitePay não publica uma consulta de identidade read-only. Um link de teste de R$1 NÃO é cobrado. */
export async function testGateway(adminId,provider,actor,{fetchImpl=globalThis.fetch}={}) {
  const row=await rowFor(adminId,provider);
  if(!row) fail(404,'GATEWAY_NOT_CONFIGURED','Cadastre as credenciais primeiro.');
  const credential=decryptSecret(row.credentials_enc);
  let verifiedRef=row.account_ref;
  if(provider==='mercadopago') {
    let response;
    try {response=await fetchImpl('https://api.mercadolibre.com/users/me',{
      headers:{Authorization:`Bearer ${credential}`},signal:AbortSignal.timeout(12000)});
    } catch {fail(502,'GATEWAY_UNAVAILABLE','Não foi possível conectar ao Mercado Pago.');}
    if(!response.ok) fail(422,'GATEWAY_TEST_FAILED','O Mercado Pago recusou o Access Token.');
    const data=await response.json().catch(()=>null);
    if(!data?.id) fail(502,'GATEWAY_BAD_RESPONSE','Mercado Pago não retornou a identidade da conta.');
    verifiedRef=String(data.id);
  } else {
    await createInfinitePay({handle:row.account_ref,apiKey:credential,fetchImpl}).createLink({
      orderNsu:`test-${randomUUID()}`,amountCents:100,description:'Teste de conexão DeltaTV (não pagar)',
      redirectUrl:env.partnerPortalUrl,
      validUntil:new Date(Date.now()+10*60_000),singlePayment:true,
    });
  }
  return sequelize.transaction(async t=>{
    await query('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
    const fresh=await rowFor(adminId,provider,t);
    if(!fresh || fresh.credential_fingerprint!==row.credential_fingerprint)
      fail(409,'GATEWAY_CHANGED','Credenciais alteradas durante o teste. Teste novamente.');
    const [saved]=await query(`UPDATE admin_network_gateways SET account_ref=:verifiedRef,
      tested_at=now(),tested_fingerprint=credential_fingerprint,updated_at=now()
      WHERE admin_user_id=CAST(:adminId AS uuid) AND provider=:provider RETURNING ${GATEWAY_COLS}`,
      {adminId,provider,verifiedRef},t);
    await audit({actor,action:'network.finance.gateway.test',entityType:'admin_user',entityId:adminId,metadata:{provider,passed:true},transaction:t});
    return noSecret(saved);
  });
}

export async function activateGateway(adminId,provider,actor) {
  return sequelize.transaction(async t=>{
    await query('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
    const row=await rowFor(adminId,provider,t);
    if(!canActivateGateway(row))fail(409,'GATEWAY_NOT_TESTED','Teste a conexão antes de ativar este provedor.');
    await query(`UPDATE admin_network_gateways SET active=false,updated_at=now() WHERE admin_user_id=CAST(:adminId AS uuid) AND active`,{adminId},t);
    await query(`UPDATE admin_network_gateways SET active=true,updated_at=now() WHERE admin_user_id=CAST(:adminId AS uuid) AND provider=:provider`,{adminId,provider},t);
    await audit({actor,action:'network.finance.gateway.activate',entityType:'admin_user',entityId:adminId,metadata:{provider},transaction:t});
    return {provider,active:true};
  });
}

export async function expireCharges() {
  await query(`UPDATE admin_network_charges SET status='expired',updated_at=now()
    WHERE status='pending' AND expires_at<=now()`);
}

/** O preço é sempre extraído do plano desta rede no banco, jamais de parâmetros da requisição. */
export async function createCharge(adminId,{partnerId,kind,planTo,method='automatic'},actor) {
  await expireCharges();
  const charge=await sequelize.transaction(async t=>{
    await query('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
    const p=await owned(adminId,partnerId,t);
    const plan=await ServicePlanCatalog.findOne({where:{key:planTo,ownerAdminId:adminId,active:true,deletedAt:null},transaction:t});
    if(!plan || (plan.audience!=='both' && plan.audience!==p.kind))
      fail(422,'PLAN_NOT_IN_NETWORK','Plano não pertence à sua rede ou é incompatível.');
    if(!plan.monthlyPriceCents || plan.monthlyPriceCents<=0)
      fail(422,'FREE_PLAN','Planos gratuitos não geram cobranças.');
    const current=await PartnerServicePlan.findByPk(p.id,{transaction:t});
    if(kind==='upgrade' && current?.tier===planTo)fail(422,'NOT_AN_UPGRADE','Selecione outro plano para o upgrade.');
    if(kind==='renewal' && current?.tier && current.tier!==planTo)
      fail(422,'PLAN_MISMATCH','Renovação deve usar o plano atual.');
    const gateway=method==='automatic'?(await query(`SELECT provider FROM admin_network_gateways WHERE admin_user_id=CAST(:adminId AS uuid) AND active=true`,{adminId},t))[0]:null;
    if(method==='automatic'&&!gateway)fail(409,'NO_ACTIVE_GATEWAY','Ative um provedor de pagamento validado.');
    const [row]=await query(`INSERT INTO admin_network_charges(owner_admin_id,partner_id,kind,plan_from,plan_to,amount_cents,status,provider,method,expires_at)
      VALUES(CAST(:adminId AS uuid),CAST(:partnerId AS uuid),:kind,:planFrom,:planTo,:amount,'creating',:provider,:method,now()+interval '24 hours') RETURNING *`,
      {adminId,partnerId,kind,planFrom:current?.tier??null,planTo,amount:plan.monthlyPriceCents,provider:gateway?.provider||null,method},t);
    await audit({actor,action:'network.finance.charge.create',entityType:'network_charge',entityId:row.id,
      metadata:{partnerId,provider:row.provider,kind,planTo,amountCents:row.amount_cents},transaction:t});
    return {row,partner:p.toJSON()};
  });
  const row=charge.row;
  if(method==='manual') {
    await query(`UPDATE admin_network_charges SET status='pending' WHERE id=CAST(:id AS uuid) AND status='creating'`,{id:row.id});
    return {id:row.id,status:'pending',method:'manual'};
  }
  try {
    const gateway=await rowFor(adminId,row.provider);
    if(!gateway)fail(503,'GATEWAY_MISSING','O provedor original não está disponível.');
    const credential=decryptSecret(gateway.credentials_enc);
    let providerRef=null,checkoutUrl=null,pixCode=null,expiresAt=row.expires_at;
    if(row.provider==='mercadopago') {
      const partnerLogin=charge.partner.contactEmail ? null : await AdminUser.findOne({where:{partnerId:charge.partner.id,role:'partner',status:'active'},attributes:['email']});
      const payerEmail=charge.partner.contactEmail||partnerLogin?.email;
      if(!payerEmail)fail(422,'PAYER_EMAIL_REQUIRED','Cadastre o e-mail de contato do parceiro antes de cobrar via Pix.');
      const payment=await createMercadoPago({accessToken:credential,webhookSecret:decryptSecret(gateway.webhook_secret_enc)}).createCharge({
        id:row.id,amountCents:Number(row.amount_cents),description:`DeltaTV ${kind==='renewal'?'renovação':'upgrade'} - ${charge.partner.name}`,
        payer:{email:payerEmail,name:charge.partner.name},expiresAt:new Date(row.expires_at),
        notificationUrl:`${env.publicBaseUrl}/api/v1/webhooks/network-finance/mercadopago/${row.id}`,
      });
      providerRef=payment.providerRef;pixCode=payment.qrCode;expiresAt=payment.expiresAt;
    } else {
      const payment=await createInfinitePay({handle:gateway.account_ref,apiKey:credential}).createLink({
        orderNsu:row.id,amountCents:Number(row.amount_cents),description:`DeltaTV ${kind==='renewal'?'renovação':'upgrade'}`,
        redirectUrl:env.partnerPortalUrl,
        webhookUrl:`${env.publicBaseUrl}/api/v1/webhooks/network-finance/infinitepay/${row.id}`,
        validUntil:new Date(row.expires_at),singlePayment:true,
      });
      checkoutUrl=payment.url;
    }
    await query(`UPDATE admin_network_charges SET status='pending',provider_ref=:providerRef,checkout_url=:checkoutUrl,
      pix_code_enc=:pixEnc,expires_at=:expiresAt,updated_at=now() WHERE id=CAST(:id AS uuid) AND status='creating'`,
      {id:row.id,providerRef,checkoutUrl,pixEnc:pixCode?encryptSecret(pixCode):null,expiresAt});
    return {id:row.id,status:'pending',method:'automatic'};
  } catch(error) {
    await query(`UPDATE admin_network_charges SET status='failed',updated_at=now() WHERE id=CAST(:id AS uuid) AND status='creating'`,{id:row.id});
    throw error;
  }
}

/** Liquida cobrança com trava e audita o aplicador do plano. */
async function settleCharge(id,verify,actor) {
  let applied=false;
  let appliedPartnerId=null;
  const settled=await sequelize.transaction(async t=>{
    const [charge]=await query(`SELECT * FROM admin_network_charges WHERE id=CAST(:id AS uuid) FOR UPDATE`,{id},t);
    if(!charge)fail(404,'NOT_FOUND','Cobrança não encontrada.');
    if(charge.status==='paid')return {id,status:'paid',alreadyPaid:true};
    if(!['pending','expired','cancelled','failed','creating'].includes(charge.status))return {id,status:charge.status};
    if(['cancelled','failed','creating'].includes(charge.status) && !verify?.providerConfirmed)return {id,status:charge.status};
    if(charge.method==='automatic' && !verify?.providerConfirmed)
      fail(403,'PROVIDER_CONFIRMATION_REQUIRED','Pagamento automático exige confirmação do próprio provedor.');
    // Em um aviso atrasado após expiração não se perde o recebimento: vai para conciliação.
    const late=['expired','cancelled','failed','creating'].includes(charge.status) || new Date(charge.expires_at)<new Date();
    const partner=await Partner.findOne({where:{id:charge.partner_id,ownerAdminId:charge.owner_admin_id},transaction:t,lock:t.LOCK.UPDATE});
    if(!partner)fail(409,'PARTNER_OWNER_CHANGED','Titularidade da parceria mudou. Cobrança requer conferência.');
    const current=await PartnerServicePlan.findByPk(charge.partner_id,{transaction:t});
    const plan=await ServicePlanCatalog.findOne({where:{key:charge.plan_to,ownerAdminId:charge.owner_admin_id},transaction:t});
    const stale=!plan || (!!charge.plan_from && current?.tier!==charge.plan_from);
    // Nunca reduzir limites abaixo das ativações em uso nem sobrepor carteira de créditos legada.
    // Em upgrade, mudanças do contrato também exigem validação; não basta trocar o nome do plano.
    const terms=charge.kind==='upgrade' && partner.kind!=='reseller'
      ? await ContentPartnerTerms.findByPk(partner.id,{transaction:t,lock:t.LOCK.UPDATE}) : null;
    const used=charge.kind==='upgrade' && plan?.activationLimit!=null
      ? await Activation.count({where:{partnerId:partner.id,status:{[Op.ne]:'revoked'}},transaction:t}) : 0;
    const blocked=charge.kind==='upgrade' && (
      (terms?.mode==='credits') || (plan?.activationLimit!=null && used>plan.activationLimit));
    const nextStatus=(late||stale||blocked)?'review':'paid';
    await query(`UPDATE admin_network_charges SET status=:status,paid_at=now(),transaction_nsu=:transaction,
      payment_slug=:slug,manual_reference=:reference,updated_at=now() WHERE id=CAST(:id AS uuid)`,
      {id,status:nextStatus,transaction:verify?.transactionNsu||null,slug:verify?.slug||null,reference:verify?.reference||null},t);
    if(nextStatus==='paid'){
      const endTime=new Date(partner.endsAt).getTime();
      const base=Math.max(Date.now(),Number.isFinite(endTime)?endTime:0);
      const reopen=partner.status==='suspended' && partner.statusReason==='awaiting_payment';
      const changes={endsAt:new Date(base+plan.validityDays*86400_000)};
      if(reopen){changes.status='active';changes.statusReason=null;changes.startsAt=new Date();}
      if(charge.kind==='upgrade'){
        changes.deviceLimit=plan.activationLimit;
        changes.monthlyFeeCents=plan.monthlyPriceCents;
        changes.billingModel='fixed';
        await PartnerServicePlan.upsert({partnerId:partner.id,tier:charge.plan_to,
          maxServersOverride:plan.maxServers},{transaction:t});
        if(partner.kind!=='reseller'){
          const updatedTerms={mode:plan.activationLimit==null?'fixed_unlimited':'fixed_limited',
            fixedFeeCents:plan.monthlyPriceCents,activationLimit:plan.activationLimit,
            autoPriority:plan.autoPriority};
          if(terms)await terms.update(updatedTerms,{transaction:t});
          else await ContentPartnerTerms.create({partnerId:partner.id,...updatedTerms,
            licensePolicy:'partner_only',creditsPerActivation:1,allowWebIssuance:false},{transaction:t});
        }
      }else if(!current)await PartnerServicePlan.upsert({partnerId:partner.id,tier:charge.plan_to},{transaction:t});
      await partner.update(changes,{transaction:t});
      applied=true;appliedPartnerId=partner.id;
    }
    await audit({actor,action:nextStatus==='paid'?'network.finance.charge.paid':'network.finance.charge.review',
      entityType:'network_charge',entityId:id,metadata:{ownerAdminId:charge.owner_admin_id,partnerId:charge.partner_id,
      method:charge.method,provider:charge.provider,manualWithoutProviderProof:charge.method==='manual',
      manualReference:verify?.reference||null,applied},transaction:t});
    return {id,status:nextStatus,applied};
  });
  if(applied){clearContractAccessCache();invalidatePlan(appliedPartnerId);}
  return settled;
}

export async function confirmManualCharge(adminId,id,{reference},actor){
  const [charge]=await query(`SELECT id,method,status FROM admin_network_charges WHERE id=CAST(:id AS uuid) AND owner_admin_id=CAST(:adminId AS uuid)`,{id,adminId});
  if(!charge)fail(404,'NOT_FOUND','Cobrança não encontrada nesta rede.');
  if(charge.method!=='manual'||charge.status!=='pending')fail(409,'INVALID_CHARGE_STATE','Somente cobrança manual pendente pode ser confirmada.');
  // Trava/estado revalidado dentro de settleCharge. Nunca simula confirmação do gateway.
  return settleCharge(id,{reference},actor);
}

/** Compatibilidade com a ficha antiga: o pagamento manual também entra no razão da rede. */
export async function confirmPendingContractFromWorkspace(adminId,partnerId,reference,actor){
  const partner=await owned(adminId,partnerId);
  if(partner.status!=='suspended'||partner.statusReason!=='awaiting_payment')
    fail(409,'NO_PENDING_PAYMENT','Não existe pagamento aguardando confirmação nesta conta.');
  const current=await PartnerServicePlan.findByPk(partnerId);
  if(!current?.tier)fail(409,'PLAN_MISSING','Plano da parceria não foi localizado.');
  const charge=await createCharge(adminId,{partnerId,kind:'renewal',planTo:current.tier,method:'manual'},actor);
  return confirmManualCharge(adminId,charge.id,{reference},actor);
}

export async function reconcileProviderCharge(id,provider,req) {
  const [charge]=await query(`SELECT * FROM admin_network_charges WHERE id=CAST(:id AS uuid) AND provider=:provider AND method='automatic'`,{id,provider});
  if(!charge)return {ignored:true};
  const gateway=await rowFor(charge.owner_admin_id,charge.provider); // inclusive inativo: cobranças antigas!
  if(!gateway)fail(503,'GATEWAY_NOT_CONFIGURED','Credenciais antigas do provedor não estão disponíveis.');
  const credential=decryptSecret(gateway.credentials_enc);
  if(provider==='mercadopago') {
    const valid=verifySignature({secret:decryptSecret(gateway.webhook_secret_enc),signatureHeader:req.get('x-signature'),
      requestId:req.get('x-request-id'),dataId:req.query?.['data.id']||req.body?.data?.id});
    if(!valid)fail(403,'INVALID_WEBHOOK_SIGNATURE','Assinatura do provedor inválida.');
    const reported=String(req.query?.['data.id']||req.body?.data?.id||'');
    if(!reported || (charge.provider_ref && reported!==String(charge.provider_ref)))return {ignored:true};
    const payment=await createMercadoPago({accessToken:credential}).getPayment(reported);
    if(payment.status!=='paid')return {ignored:true};
    if(payment.externalReference!==charge.id || payment.amountCents!==Number(charge.amount_cents) ||
      (gateway.account_ref!=='pending'&&payment.collectorId!==gateway.account_ref))
      fail(409,'PAYMENT_MISMATCH','Recebimento não corresponde à cobrança.');
    return settleCharge(id,{providerConfirmed:true}, {type:'system',id:null,role:'webhook'});
  }
  const transactionNsu=String(req.body?.transaction_nsu||req.body?.transactionNsu||'');
  const slug=String(req.body?.slug||'');
  if(!/^[\w-]{1,160}$/.test(transactionNsu)|| !/^[\w-]{1,160}$/.test(slug))return {ignored:true};
  const payment=await createInfinitePay({handle:gateway.account_ref,apiKey:credential}).paymentCheck({orderNsu:charge.id,transactionNsu,slug});
  if(!payment.paid)return {ignored:true};
  const value=payment.paidAmountCents??payment.amountCents;
  if(value!==Number(charge.amount_cents))fail(409,'PAYMENT_MISMATCH','Valor confirmado não corresponde à cobrança.');
  return settleCharge(id,{providerConfirmed:true,transactionNsu,slug}, {type:'system',id:null,role:'webhook'});
}

export async function cancelCharge(id,reason,actor,{ownerAdminId=null,superadmin=false}={}) {
  return sequelize.transaction(async t=>{
    const [row]=await query(`SELECT id,status FROM admin_network_charges WHERE id=CAST(:id AS uuid)
      ${superadmin?'':'AND owner_admin_id=CAST(:owner AS uuid)'} FOR UPDATE`,{id,owner:asOwner(ownerAdminId)},t);
    if(!row)fail(404,'NOT_FOUND','Cobrança não encontrada nesta rede.');
    if(row.status!=='pending')fail(409,'NOT_PENDING','Só é possível cancelar cobrança pendente.');
    await query(`UPDATE admin_network_charges SET status='cancelled',cancellation_reason=:reason,
      cancelled_by=CAST(:actor AS uuid),updated_at=now() WHERE id=CAST(:id AS uuid)`,{id,reason,actor:actor.id},t);
    await audit({actor,action:superadmin?'network.finance.charge.super_cancel':'network.finance.charge.cancel',
      entityType:'network_charge',entityId:id,metadata:{reason},transaction:t});
    return {id,status:'cancelled'};
  });
}

const FILTERS=`FROM admin_network_charges c
 JOIN partners p ON p.id=c.partner_id
 JOIN admin_users a ON a.id=c.owner_admin_id
 WHERE (:owner IS NULL OR c.owner_admin_id=CAST(:owner AS uuid))
   AND (:adminId IS NULL OR c.owner_admin_id=CAST(:adminId AS uuid))
   AND (:partnerId IS NULL OR c.partner_id=CAST(:partnerId AS uuid))
   AND (:kind IS NULL OR c.kind=:kind)
   AND (:status IS NULL OR c.status=:status)
   AND (:provider IS NULL OR c.provider=:provider)
   AND (:method IS NULL OR c.method=:method)
   AND (:fromDate IS NULL OR c.created_at >= CAST(:fromDate AS timestamptz))
   AND (:toDate IS NULL OR c.created_at < CAST(:toDate AS timestamptz)+interval '1 day')`;
const FIELDS=`c.id,c.owner_admin_id AS "adminId",a.name AS "adminName",c.partner_id AS "partnerId",p.name AS "partnerName",
 c.kind,c.plan_from AS "planFrom",c.plan_to AS "planTo",c.amount_cents AS "amountCents",c.status,c.provider,c.method,
 c.created_at AS "createdAt",c.paid_at AS "paidAt",c.expires_at AS "expiresAt",
 CASE WHEN c.method='manual' THEN c.manual_reference ELSE c.provider_ref END AS reference,
 CASE WHEN c.method='manual' AND c.status IN ('paid','review') THEN true ELSE false END AS "manualWithoutProviderProof"`;
const filtered = ({adminId,partnerId,kind,status,provider,method,fromDate,toDate},owner) => ({
  owner,adminId:adminId||null,partnerId:partnerId||null,kind:kind||null,status:status||null,
  provider:provider||null,method:method||null,fromDate:fromDate||null,toDate:toDate||null,
});
export async function listCharges(filters={}, {ownerAdminId=null,superadmin=false,limit=25,offset=0}={}) {
  await expireCharges();
  const args=filtered(filters,superadmin?null:asOwner(ownerAdminId));
  const [rows,count,totals,byAdmin,byPeriod]=await Promise.all([
    query(`SELECT ${FIELDS} ${FILTERS} ORDER BY c.created_at DESC,c.id DESC LIMIT :limit OFFSET :offset`,{...args,limit,offset}),
    query(`SELECT count(*)::int AS n ${FILTERS}`,args),
    query(`SELECT COALESCE(sum(amount_cents) FILTER(WHERE status='paid'),0)::bigint AS paid,
       COALESCE(sum(amount_cents) FILTER(WHERE status='pending'),0)::bigint AS pending,
       COALESCE(sum(amount_cents) FILTER(WHERE status='expired'),0)::bigint AS expired ${FILTERS}`,args),
    query(`SELECT c.owner_admin_id AS "adminId",a.name AS "adminName",
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='paid'),0)::bigint AS paid,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='pending'),0)::bigint AS pending,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='expired'),0)::bigint AS expired ${FILTERS}
       GROUP BY c.owner_admin_id,a.name ORDER BY a.name LIMIT 500`,args),
    query(`SELECT to_char(date_trunc('month',c.created_at),'YYYY-MM') AS period,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='paid'),0)::bigint AS paid,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='pending'),0)::bigint AS pending,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='expired'),0)::bigint AS expired ${FILTERS}
       GROUP BY date_trunc('month',c.created_at) ORDER BY period DESC LIMIT 120`,args),
  ]);
  return {data:rows,meta:{page:Math.floor(offset/limit)+1,pageSize:limit,total:count[0]?.n||0},totals:totals[0],byAdmin,byPeriod};
}
export async function exportChargesCsv(filters,{superadmin=false,ownerAdminId=null,limit=2000}={}) {
  await expireCharges();
  const params=filtered(filters,superadmin?null:asOwner(ownerAdminId));
  const rows=await query(`SELECT ${FIELDS} ${FILTERS} ORDER BY c.created_at DESC,c.id DESC LIMIT :limit`,{...params,limit});
  const keys=['adminName','partnerName','kind','planFrom','planTo','amountCents','status','provider','method','createdAt','paidAt','reference','manualWithoutProviderProof'];
  return [keys.join(','),...rows.map(row=>keys.map(k=>csvSafe(row[k] instanceof Date?row[k].toISOString():row[k])).join(','))].join('\r\n')+'\r\n';
}
export async function partnerCharges(partnerId) {
  await expireCharges();
  const rows=await query(`SELECT id,kind,plan_to,amount_cents,status,method,checkout_url,pix_code_enc,expires_at,created_at
    FROM admin_network_charges WHERE partner_id=CAST(:partnerId AS uuid)
    ORDER BY created_at DESC LIMIT 30`,{partnerId});
  return rows.map(r=>({id:r.id,kind:r.kind,planTo:r.plan_to,amountCents:r.amount_cents,status:r.status,
    expiresAt:r.expires_at,createdAt:r.created_at,
    ...(r.status==='pending'&&r.method==='automatic' ? {
      ...(r.pix_code_enc?{pixCode:decryptSecret(r.pix_code_enc)}:{}),
      ...(r.checkout_url?{checkoutUrl:r.checkout_url}:{}),
    }:{}),
  }));
}

export async function maskedAdminGatewaySummary() {
  return query(`SELECT a.id AS "adminId",a.name AS "adminName",g.provider,g.active,g.tested_at AS "testedAt",g.account_ref AS "accountRef"
    FROM admin_users a LEFT JOIN LATERAL (
      SELECT provider,active,tested_at,account_ref FROM admin_network_gateways
      WHERE admin_user_id=a.id ORDER BY active DESC,updated_at DESC LIMIT 1
    ) g ON true
    WHERE a.role='admin' AND a.deleted_at IS NULL ORDER BY a.name LIMIT 500`).then(rows=>rows.map(({accountRef,...r})=>({ ...r,configured:!!r.provider,accountRefMasked:maskAccountRef(accountRef)})));
}
