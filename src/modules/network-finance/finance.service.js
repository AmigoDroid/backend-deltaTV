import { randomUUID } from 'node:crypto';
import { pixExpiry,requiredSettlementCents } from './charge-pricing.js';
import { quoteNetworkCharge } from './pricing.service.js';
import { oneOffQuote } from './one-off.js';
import { verifyNetworkPaymentMatch, infinitePayWebhookReference } from './policy.js';
import { QueryTypes, Op } from 'sequelize';
import { sequelize, Partner, AdminUser, PartnerServicePlan, ServicePlanCatalog, ContentPartnerTerms, Activation } from '../../db/models/index.js';
import { encryptSecret, decryptSecret } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { clearContractAccessCache } from '../access/access.service.js';
import { invalidatePlan } from '../service-plans/plan.service.js';
import { createMercadoPago, verifySignature } from '../pix/providers/mercadopago.js';
import { createInfinitePay, HANDLE_RE, normalizeHandle } from '../distribution/gateways/infinitepay.js';
import { inspectCreatingCharge } from './provider-lookup.js';
import { canActivateGateway, csvSafe, fingerprint, maskAccountRef } from './policy.js';
import { env } from '../../config/env.js';

const fail = (status,code,message) => {throw new AppError(status,code,message)};
const query = (sql, params={},transaction) => sequelize.query(sql, {type:QueryTypes.SELECT,replacements:params,...(transaction?{transaction}:{})});
const asOwner = id => id || '00000000-0000-0000-0000-000000000000';
const quoteDescription=row=>String(row?.breakdown?.description||'Cobrança avulsa DeltaTV').slice(0,200);
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

/** Prévia obrigatória também para avulsas; o Admin define o valor, nunca o pagador. */
export async function previewOneOffCharge(adminId,input) {
  await owned(adminId,input.partnerId);
  return oneOffQuote({...input,adminId});
}
export async function createOneOffCharge(adminId,input,actor) {
  return createCharge(adminId,{...input,kind:'one_off',planTo:null},actor);
}

/** Renovação/upgrade usam o catálogo; cobrança avulsa tem valor definido pela administração. */
export async function createCharge(adminId,{partnerId,kind,planTo,method='automatic',previewFingerprint,manualDiscount=null,waiver=null,
  amountCents=null,description=null},actor,{skipPreview=false}={}) {
  await expireCharges();
  const charge=await sequelize.transaction(async t=>{
    await query('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
    const p=await owned(adminId,partnerId,t);
    // Trava o contrato para a criação e prévia terem a mesma referência.
    await query('SELECT id FROM partners WHERE id=CAST(:partnerId AS uuid) FOR UPDATE',{partnerId},t);
    const quote=kind==='one_off'
      ? oneOffQuote({adminId,partnerId,amountCents,description,method})
      : await quoteNetworkCharge(adminId,{partnerId,kind,planTo,manualDiscount,waiver},actor,{transaction:t});
    if(!skipPreview && (!previewFingerprint||previewFingerprint!==quote.previewFingerprint))
      throw new AppError(409,'PRICING_CHANGED','O valor da prévia mudou. Confirme o cálculo atualizado.',{quote});
    const gateway=method==='automatic'?(await query(`SELECT provider FROM admin_network_gateways WHERE admin_user_id=CAST(:adminId AS uuid) AND active=true`,{adminId},t))[0]:null;
    if(method==='automatic'&&!gateway)fail(409,'NO_ACTIVE_GATEWAY','Ative um provedor de pagamento validado.');
    const expiresAt=pixExpiry(new Date(),60);
    if(expiresAt.getTime()<=Date.now()+1000)fail(409,'PRICING_DAY_END','O dia está virando; recalcule o pagamento.');
    const [row]=await query(`INSERT INTO admin_network_charges(owner_admin_id,partner_id,kind,plan_from,plan_to,amount_cents,status,provider,method,expires_at,breakdown)
      VALUES(CAST(:adminId AS uuid),CAST(:partnerId AS uuid),:kind,:planFrom,:planTo,:amount,'creating',:provider,:method,:expiresAt,CAST(:breakdown AS jsonb)) RETURNING *`,
      {adminId,partnerId,kind,planFrom:quote.planFrom,planTo:quote.planTo,amount:quote.amountCents,provider:gateway?.provider||null,
        method,expiresAt,breakdown:JSON.stringify(quote.breakdown)},t);
    await audit({actor,action:'network.finance.charge.create',entityType:'network_charge',entityId:row.id,
      metadata:{partnerId,provider:row.provider,kind,planTo:quote.planTo,amountCents:row.amount_cents,description:kind==='one_off'?quote.description:null},transaction:t});
    if(manualDiscount)await audit({actor,action:'network.finance.charge.manual_discount',entityType:'network_charge',entityId:row.id,
      metadata:{discount:quote.breakdown.manual,amountCents:quote.breakdown.manualDiscountCents},transaction:t});
    if(waiver)await audit({actor,action:'network.finance.charge.waiver',entityType:'network_charge',entityId:row.id,
      metadata:{reason:waiver.reason,feeCents:quote.breakdown.waiverFeeCents,interestCents:quote.breakdown.waiverInterestCents},transaction:t});
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
        id:row.id,amountCents:Number(row.amount_cents),description:kind==='one_off'?quoteDescription(row):`DeltaTV ${kind==='renewal'?'renovação':'upgrade'} - ${charge.partner.name}`,
        payer:{email:payerEmail,name:charge.partner.name},expiresAt:new Date(row.expires_at),
        notificationUrl:`${env.publicBaseUrl}/api/v1/webhooks/network-finance/mercadopago/${row.id}`,
      });
      providerRef=payment.providerRef;pixCode=payment.qrCode;expiresAt=new Date(Math.min(new Date(payment.expiresAt||row.expires_at).getTime(),new Date(row.expires_at).getTime()));
    } else {
      const payment=await createInfinitePay({handle:gateway.account_ref,apiKey:credential}).createLink({
        orderNsu:row.id,amountCents:Number(row.amount_cents),description:kind==='one_off'?quoteDescription(row):`DeltaTV ${kind==='renewal'?'renovação':'upgrade'}`,
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
    // Falha da resposta NÃO prova que o provedor deixou de criar o Pix.
    // Manter o vínculo em 'creating' impede emitir outra cobrança até a conciliação.
    await query(`UPDATE admin_network_charges SET review_reason='PROVIDER_CREATE_RESPONSE_UNKNOWN',
      updated_at=now() WHERE id=CAST(:id AS uuid) AND status='creating'`,{id:row.id});
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
    // Expirar o QR não invalida um pagamento comprovado do valor integral.
    const partner=await Partner.findOne({where:{id:charge.partner_id,ownerAdminId:charge.owner_admin_id},transaction:t,lock:t.LOCK.UPDATE});
    if(!partner)fail(409,'PARTNER_OWNER_CHANGED','Titularidade da parceria mudou. Cobrança requer conferência.');
    if(charge.kind==='one_off') {
      await query(`UPDATE admin_network_charges SET status='paid',paid_at=now(),transaction_nsu=:transaction,
        payment_slug=:slug,manual_reference=:reference,paid_amount_cents=:paidAmount,updated_at=now()
        WHERE id=CAST(:id AS uuid)`,
        {id,transaction:verify?.transactionNsu||null,slug:verify?.slug||null,reference:verify?.reference||null,
          paidAmount:verify?.amountCents??Number(charge.amount_cents)},t);
      await audit({actor,action:'network.finance.one_off.paid',entityType:'network_charge',entityId:id,
        metadata:{ownerAdminId:charge.owner_admin_id,partnerId:charge.partner_id,method:charge.method,
          provider:charge.provider,manualWithoutProviderProof:charge.method==='manual',applied:false},transaction:t});
      return {id,status:'paid',applied:false};
    }
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
    const nextStatus=(stale||blocked)?'needs_review':'paid';
    await query(`UPDATE admin_network_charges SET status=:status,paid_at=now(),transaction_nsu=:transaction,
      payment_slug=:slug,manual_reference=:reference,paid_amount_cents=:paidAmount,updated_at=now() WHERE id=CAST(:id AS uuid)`,
      {id,status:nextStatus,transaction:verify?.transactionNsu||null,slug:verify?.slug||null,reference:verify?.reference||null,paidAmount:verify?.amountCents??Number(charge.amount_cents)},t);
    if(nextStatus==='paid'){
      const endTime=new Date(partner.endsAt).getTime();
      const overdue=Number.isFinite(endTime)&&endTime<Date.now();
      const base=Math.max(Date.now(),Number.isFinite(endTime)?endTime:0);
      const reopen=partner.status==='suspended' && partner.statusReason==='awaiting_payment';
      const snapshotDays=Number(charge.breakdown?.validityDays||plan.validityDays);
      const changes={endsAt:charge.kind==='upgrade'&&!overdue&&Number.isFinite(endTime)?new Date(endTime):new Date((overdue?Date.now():base)+snapshotDays*86400_000)};
      if(charge.kind==='upgrade'&&overdue)changes.startsAt=new Date();
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

/** Superadmin pode conferir manualmente SOMENTE avulsas das redes, sempre auditado. */
export async function confirmOneOffManualAsSuper(id,{reference},actor) {
  const [row]=await query(`SELECT owner_admin_id,kind FROM admin_network_charges WHERE id=CAST(:id AS uuid)`,{id});
  if(!row)fail(404,'NOT_FOUND','Cobrança não encontrada.');
  if(row.kind!=='one_off')fail(403,'ONE_OFF_ONLY','Use o fluxo contratual de confirmação para planos.');
  return confirmManualCharge(row.owner_admin_id,id,{reference},actor);
}

/** Compatibilidade com a ficha antiga: o pagamento manual também entra no razão da rede. */
export async function confirmPendingContractFromWorkspace(adminId,partnerId,reference,actor){
  const partner=await owned(adminId,partnerId);
  if(partner.status!=='suspended'||partner.statusReason!=='awaiting_payment')
    fail(409,'NO_PENDING_PAYMENT','Não existe pagamento aguardando confirmação nesta conta.');
  const current=await PartnerServicePlan.findByPk(partnerId);
  if(!current?.tier)fail(409,'PLAN_MISSING','Plano da parceria não foi localizado.');
  const charge=await createCharge(adminId,{partnerId,kind:'renewal',planTo:current.tier,method:'manual'},actor,{skipPreview:true});
  return confirmManualCharge(adminId,charge.id,{reference},actor);
}

async function needsReview(id,reason,amount,actor,{onlyCreating=false}={}){
  return sequelize.transaction(async t=>{
    const [charge]=await query(`SELECT status FROM admin_network_charges WHERE id=CAST(:id AS uuid) FOR UPDATE`,{id},t);
    if(!charge)return {ignored:true};
    if(onlyCreating && charge.status!=='creating')return {id,status:charge.status,ignored:true};
    if(charge.status==='paid')return {id,status:'paid',alreadyPaid:true};
    if(charge.status==='needs_review')return {id,status:'needs_review',alreadyReviewed:true};
    await query(`UPDATE admin_network_charges SET status='needs_review',
      paid_at=CASE WHEN :amount IS NOT NULL THEN now() ELSE paid_at END,
      paid_amount_cents=:amount,review_reason=:reason,updated_at=now() WHERE id=CAST(:id AS uuid)`,
      {id,reason,amount:Number.isSafeInteger(amount)&&amount>=0?amount:null},t);
    await audit({actor,action:'network.finance.charge.needs_review',entityType:'network_charge',entityId:id,
      metadata:{reason,amountCents:amount},transaction:t});
    return {id,status:'needs_review'};
  });
}

/** URL fixa cadastrável no painel Mercado Pago. A referência identifica o gateway correto,
 * mas a assinatura e o pagamento são revalidados pelo mesmo reconciliador da rota por cobrança. */
export async function reconcileMercadoPagoNotification(req){
  const paymentId=String(req.query?.['data.id']||req.body?.data?.id||'');
  if(!/^\d{1,20}$/.test(paymentId))return {ignored:true};
  const [charge]=await query(`SELECT id FROM admin_network_charges WHERE provider='mercadopago'
    AND provider_ref=:paymentId LIMIT 1`,{paymentId});
  if(!charge)return {ignored:true};
  return reconcileProviderCharge(charge.id,'mercadopago',req);
}

export async function reconcileProviderCharge(id,provider,req) {
  const [charge]=await query(`SELECT * FROM admin_network_charges WHERE id=CAST(:id AS uuid) AND provider=:provider AND method='automatic'`,{id,provider});
  if(!charge)return {ignored:true};
  if(['paid','needs_review'].includes(charge.status))return {id,status:charge.status,alreadySettled:true};
  const gateway=await rowFor(charge.owner_admin_id,charge.provider);
  if(!gateway)fail(503,'GATEWAY_NOT_CONFIGURED','Credenciais antigas do provedor não estão disponíveis.');
  const credential=decryptSecret(gateway.credentials_enc),actor={type:'system',id:null,role:'webhook'};
  if(provider==='mercadopago') {
    const valid=verifySignature({secret:decryptSecret(gateway.webhook_secret_enc),signatureHeader:req.get('x-signature'),
      requestId:req.get('x-request-id'),dataId:req.query?.['data.id']||req.body?.data?.id});
    if(!valid)fail(403,'INVALID_WEBHOOK_SIGNATURE','Assinatura do provedor inválida.');
    const reported=String(req.query?.['data.id']||req.body?.data?.id||'');
    if(!reported || (charge.provider_ref && reported!==String(charge.provider_ref)))return {ignored:true};
    const payment=await createMercadoPago({accessToken:credential}).getPayment(reported);
    if(payment.status!=='paid')return {ignored:true};
    const owed=new Date(charge.expires_at)<new Date()?requiredSettlementCents(charge.breakdown,new Date(),Number(charge.amount_cents)):Number(charge.amount_cents);
    const receipt={confirmed:true,externalReference:payment.externalReference,providerRef:reported,
      amountCents:payment.amountCents,currency:payment.currency,paymentMethod:payment.paymentMethod,collectorId:payment.collectorId};
    if(!verifyNetworkPaymentMatch({...charge,amount_cents:owed},receipt,gateway.account_ref))
      return needsReview(id,'PAYMENT_MISMATCH',payment.amountCents,actor);
    return settleCharge(id,{providerConfirmed:true,amountCents:payment.amountCents},actor);
  }
  const reference=infinitePayWebhookReference(req.body);
  if(!reference)return {ignored:true};
  const {transactionNsu,slug}=reference;
  const payment=await createInfinitePay({handle:gateway.account_ref,apiKey:credential}).paymentCheck({orderNsu:charge.id,transactionNsu,slug});
  if(!payment.paid)return {ignored:true};
  const amount=payment.paidAmountCents??payment.amountCents;
  const owed=new Date(charge.expires_at)<new Date()?requiredSettlementCents(charge.breakdown,new Date(),Number(charge.amount_cents)):Number(charge.amount_cents);
  const receipt={confirmed:true,externalReference:charge.id,providerRef:charge.provider_ref,
    amountCents:amount,currency:payment.currency||'BRL',paymentMethod:String(payment.captureMethod||'').trim().toLowerCase(),collectorId:gateway.account_ref};
  if(!verifyNetworkPaymentMatch({...charge,amount_cents:owed},receipt,gateway.account_ref))
    return needsReview(id,'PAYMENT_MISMATCH',amount,actor);
  return settleCharge(id,{providerConfirmed:true,transactionNsu,slug,amountCents:amount},actor);
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
   AND (:lateOnly IS NULL OR (COALESCE((c.breakdown->>'daysLate')::int,0)>0)=:lateOnly)
   AND (:earlyOnly IS NULL OR (COALESCE((c.breakdown->>'earlyDiscountCents')::bigint,0)>0)=:earlyOnly)
   AND (:manualOnly IS NULL OR (COALESCE((c.breakdown->>'manualDiscountCents')::bigint,0)>0)=:manualOnly)
   AND (:waiverOnly IS NULL OR (COALESCE((c.breakdown->>'waiverFeeCents')::bigint,0)+COALESCE((c.breakdown->>'waiverInterestCents')::bigint,0)>0)=:waiverOnly)
   AND (:fromDate IS NULL OR c.created_at >= (CAST(:fromDate AS date)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
   AND (:toDate IS NULL OR c.created_at < ((CAST(:toDate AS date)+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))`;
const FIELDS=`c.id,c.owner_admin_id AS "adminId",a.name AS "adminName",c.partner_id AS "partnerId",p.name AS "partnerName",
 c.kind,c.plan_from AS "planFrom",c.plan_to AS "planTo",c.breakdown->>'description' AS "description",c.amount_cents AS "amountCents",c.breakdown,c.review_reason AS "reviewReason",c.status,c.provider,c.method,
 c.created_at AS "createdAt",c.paid_at AS "paidAt",c.expires_at AS "expiresAt",
 CASE WHEN c.method='manual' THEN c.manual_reference ELSE c.provider_ref END AS reference,
 CASE WHEN c.method='manual' AND c.status IN ('paid','review','needs_review') THEN true ELSE false END AS "manualWithoutProviderProof"`;
const filtered = ({adminId,partnerId,kind,status,provider,method,fromDate,toDate,lateOnly,earlyOnly,manualOnly,waiverOnly},owner) => ({
  owner,adminId:adminId||null,partnerId:partnerId||null,kind:kind||null,status:status||null,
  provider:provider||null,method:method||null,fromDate:fromDate||null,toDate:toDate||null,
  lateOnly:lateOnly??null,earlyOnly:earlyOnly??null,manualOnly:manualOnly??null,waiverOnly:waiverOnly??null,
});
export async function listCharges(filters={}, {ownerAdminId=null,superadmin=false,limit=25,offset=0}={}) {
  await expireCharges();
  const args=filtered(filters,superadmin?null:asOwner(ownerAdminId));
  const [rows,count,totals,byAdmin,byPeriod]=await Promise.all([
    query(`SELECT ${FIELDS} ${FILTERS} ORDER BY c.created_at DESC,c.id DESC LIMIT :limit OFFSET :offset`,{...args,limit,offset}),
    query(`SELECT count(*)::int AS n ${FILTERS}`,args),
    query(`SELECT COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='paid'),0)::bigint AS paid,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='pending'),0)::bigint AS pending,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='expired'),0)::bigint AS expired,
       COALESCE(sum(COALESCE((c.breakdown->>'lateFeeCents')::bigint,0)),0)::bigint AS late_fees,
       COALESCE(sum(COALESCE((c.breakdown->>'interestCents')::bigint,0)),0)::bigint AS interest,
       COALESCE(sum(COALESCE((c.breakdown->>'earlyDiscountCents')::bigint,0)+COALESCE((c.breakdown->>'manualDiscountCents')::bigint,0)),0)::bigint AS discounts,
       COALESCE(sum(COALESCE((c.breakdown->>'waiverFeeCents')::bigint,0)+COALESCE((c.breakdown->>'waiverInterestCents')::bigint,0)),0)::bigint AS waivers ${FILTERS}`,args),
    query(`SELECT c.owner_admin_id AS "adminId",a.name AS "adminName",
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='paid'),0)::bigint AS paid,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='pending'),0)::bigint AS pending,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='expired'),0)::bigint AS expired,
       COALESCE(sum(COALESCE((c.breakdown->>'lateFeeCents')::bigint,0)),0)::bigint AS late_fees,
       COALESCE(sum(COALESCE((c.breakdown->>'interestCents')::bigint,0)),0)::bigint AS interest,
       COALESCE(sum(COALESCE((c.breakdown->>'earlyDiscountCents')::bigint,0)+COALESCE((c.breakdown->>'manualDiscountCents')::bigint,0)),0)::bigint AS discounts,
       COALESCE(sum(COALESCE((c.breakdown->>'waiverFeeCents')::bigint,0)+COALESCE((c.breakdown->>'waiverInterestCents')::bigint,0)),0)::bigint AS waivers ${FILTERS}
       GROUP BY c.owner_admin_id,a.name ORDER BY a.name LIMIT 500`,args),
    query(`SELECT to_char(date_trunc('month',c.created_at AT TIME ZONE 'America/Sao_Paulo'),'YYYY-MM') AS period,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='paid'),0)::bigint AS paid,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='pending'),0)::bigint AS pending,
       COALESCE(sum(c.amount_cents) FILTER(WHERE c.status='expired'),0)::bigint AS expired,
       COALESCE(sum(COALESCE((c.breakdown->>'lateFeeCents')::bigint,0)),0)::bigint AS late_fees,
       COALESCE(sum(COALESCE((c.breakdown->>'interestCents')::bigint,0)),0)::bigint AS interest,
       COALESCE(sum(COALESCE((c.breakdown->>'earlyDiscountCents')::bigint,0)+COALESCE((c.breakdown->>'manualDiscountCents')::bigint,0)),0)::bigint AS discounts,
       COALESCE(sum(COALESCE((c.breakdown->>'waiverFeeCents')::bigint,0)+COALESCE((c.breakdown->>'waiverInterestCents')::bigint,0)),0)::bigint AS waivers ${FILTERS}
       GROUP BY date_trunc('month',c.created_at AT TIME ZONE 'America/Sao_Paulo') ORDER BY period DESC LIMIT 120`,args),
  ]);
  return {data:rows,meta:{page:Math.floor(offset/limit)+1,pageSize:limit,total:count[0]?.n||0},totals:totals[0],byAdmin,byPeriod};
}
export async function exportChargesCsv(filters,{superadmin=false,ownerAdminId=null,limit=2000}={}) {
  await expireCharges();
  const params=filtered(filters,superadmin?null:asOwner(ownerAdminId));
  const rows=await query(`SELECT ${FIELDS} ${FILTERS} ORDER BY c.created_at DESC,c.id DESC LIMIT :limit`,{...params,limit});
  const keys=['adminName','partnerName','kind','description','planFrom','planTo','amountCents','status','provider','method','createdAt','paidAt','reference','manualWithoutProviderProof',
    'lateFeeCents','interestCents','earlyDiscountCents','manualDiscountCents','waiverFeeCents','waiverInterestCents'];
  return [keys.join(','),...rows.map(row=>keys.map(k=>{const value=k in (row.breakdown||{})?row.breakdown[k]:row[k];return csvSafe(value instanceof Date?value.toISOString():value)}).join(','))].join('\r\n')+'\r\n';
}
export async function partnerCharges(partnerId) {
  await expireCharges();
  const rows=await query(`SELECT id,kind,plan_to,amount_cents,breakdown,status,method,checkout_url,pix_code_enc,expires_at,created_at
    FROM admin_network_charges WHERE partner_id=CAST(:partnerId AS uuid)
    ORDER BY created_at DESC LIMIT 30`,{partnerId});
  return rows.map(r=>{const b=r.breakdown||{};return ({id:r.id,kind:r.kind,planTo:r.plan_to,
    ...(r.kind==='one_off'?{description:String(b.description||'Cobrança avulsa').slice(0,200)}:{}),amountCents:r.amount_cents,
    // A conta do pagador nunca inclui identidade, motivo, tipo de desconto
    // manual ou configurações internas do Administrador.
    breakdown:b.totalCents?Object.fromEntries(['baseCents','earlyDiscountCents','manualDiscountCents',
      'lateFeeCents','interestCents','daysLate','lateFeePct','interestMonthlyPct',
      'waiverFeeCents','waiverInterestCents','totalCents'].map(k=>[k,b[k]??0])):null,status:r.status,
    expiresAt:r.expires_at,createdAt:r.created_at,
    ...(r.status==='pending'&&r.method==='automatic' ? {
      ...(r.pix_code_enc?{pixCode:decryptSecret(r.pix_code_enc)}:{}),
      ...(r.checkout_url?{checkoutUrl:r.checkout_url}:{}),
    }:{}),
  });});
}

export async function maskedAdminGatewaySummary() {
  return query(`SELECT a.id AS "adminId",a.name AS "adminName",g.provider,g.active,g.tested_at AS "testedAt",g.account_ref AS "accountRef"
    FROM admin_users a LEFT JOIN LATERAL (
      SELECT provider,active,tested_at,account_ref FROM admin_network_gateways
      WHERE admin_user_id=a.id ORDER BY active DESC,updated_at DESC LIMIT 1
    ) g ON true
    WHERE a.role='admin' AND a.deleted_at IS NULL ORDER BY a.name LIMIT 500`).then(rows=>rows.map(({accountRef,...r})=>({ ...r,configured:!!r.provider,accountRefMasked:maskAccountRef(accountRef)})));
}

/**
 * Worker de conciliação idempotente de cobranças presas em criação.
 * O claim usa SKIP LOCKED e CHECKED_AT para evitar a mesma cobrança em dois
 * workers; consultas de rede são feitas FORA de transações do PostgreSQL.
 * NUNCA cria nova cobrança. Provedores são consultados apenas por referência.
 */
export async function recoverStaleCreatingCharges({now=new Date(),limit=25,staleMinutes=10,maxAttempts=3,
  inspect=inspectCreatingCharge}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>100 || !Number.isInteger(staleMinutes)||staleMinutes<1||staleMinutes>1440
      || !Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)
    throw new RangeError('Parâmetros de recuperação inválidos.');
  const cutoff=new Date(new Date(now).getTime()-staleMinutes*60_000);
  const rows=await sequelize.transaction(async transaction=>query(`WITH claimed AS (
      SELECT id FROM admin_network_charges
      WHERE status='creating' AND updated_at<=:cutoff
        AND (recovery_checked_at IS NULL OR recovery_checked_at<=:cutoff)
      ORDER BY updated_at ASC,id ASC LIMIT :limit FOR UPDATE SKIP LOCKED
    )
    UPDATE admin_network_charges c SET recovery_attempts=c.recovery_attempts+1,
      recovery_checked_at=:now
    FROM claimed WHERE c.id=claimed.id
    RETURNING c.*`,{cutoff,now,limit},transaction));
  const result={checked:rows.length,recovered:0,paid:0,needsReview:0,errors:0};
  const actor={type:'system',id:null,role:'reconciliation'};
  for(const charge of rows){
    try {
      const gateway=await rowFor(charge.owner_admin_id,charge.provider);
      const outcome=await inspect(charge,{
        accountRef:gateway?.account_ref,credential:gateway?.credentials_enc?decryptSecret(gateway.credentials_enc):null,
      },{now});
      if(outcome.kind==='paid') {
        // Only persist the provider ID for this same locked owner+charge.
        if(outcome.providerRef)await query(`UPDATE admin_network_charges
          SET provider_ref=:ref,updated_at=now()
          WHERE id=CAST(:id AS uuid) AND owner_admin_id=CAST(:owner AS uuid)
            AND status='creating' AND (provider_ref IS NULL OR provider_ref=:ref)`,
          {id:charge.id,owner:charge.owner_admin_id,ref:outcome.providerRef});
        const settled=await settleCharge(charge.id,{providerConfirmed:true,
          amountCents:outcome.amountCents,transactionNsu:outcome.transactionNsu,slug:outcome.slug},actor);
        if(settled.status==='paid')result.paid++;
        else if(settled.status==='needs_review')result.needsReview++;
      } else if(outcome.kind==='pending' && outcome.providerRef) {
        const updated=await query(`UPDATE admin_network_charges SET status='pending',provider_ref=:ref,
          pix_code_enc=COALESCE(pix_code_enc,:pix),updated_at=now()
          WHERE id=CAST(:id AS uuid) AND owner_admin_id=CAST(:owner AS uuid)
            AND status='creating' AND (provider_ref IS NULL OR provider_ref=:ref)
          RETURNING id`,{id:charge.id,owner:charge.owner_admin_id,
          ref:outcome.providerRef,pix:outcome.qrCode?encryptSecret(outcome.qrCode):null});
        if(updated.length)result.recovered++;
      } else if(outcome.kind==='review') {
        const reviewed=await needsReview(charge.id,outcome.reason,outcome.receivedCents??null,actor,{onlyCreating:true});
        if(reviewed.status==='needs_review')result.needsReview++;
      } else if(Number(charge.recovery_attempts)>=maxAttempts) {
        const reviewed=await needsReview(charge.id,outcome.reason||'CREATING_UNVERIFIED',null,actor,{onlyCreating:true});
        if(reviewed.status==='needs_review')result.needsReview++;
      }
    } catch(error) {
      result.errors++;
      // Provider downtime never becomes proof of payment. After bounded retries,
      // stop the loop by requesting review (no contract extension).
      if(Number(charge.recovery_attempts)>=maxAttempts){
        const reviewed=await needsReview(charge.id,'PROVIDER_LOOKUP_UNAVAILABLE',null,actor,{onlyCreating:true});
        if(reviewed.status==='needs_review')result.needsReview++;
      }
      // Never log credentials or provider response bodies.
      console.warn(`[finance-recovery] consulta falhou para cobrança ${charge.id}: ${error.code||'LOOKUP_ERROR'}`);
    }
  }
  return result;
}
