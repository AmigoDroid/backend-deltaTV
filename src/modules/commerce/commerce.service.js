import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { sequelize, Partner } from '../../db/models/index.js';
import { audit } from '../../shared/audit.js';
import { AppError, notFound } from '../../shared/errors.js';
import { normalizeMac } from '../../shared/mac.js';
import { availableSlots } from './commerce.policy.js';

const rows = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.RAW });
const fail = (status, code, message) => new AppError(status, code, message);
const assertOwnedCustomer = async (id, partnerId, t) => {
  const customer = (await rows('SELECT * FROM commerce_customers WHERE id=:id AND partner_id=:partnerId', { id, partnerId }, t))[0];
  if (!customer) throw notFound('Cliente comercial');
  return customer;
};
const assertSubscription = async (id, partnerId, t, lock = false) => {
  const sub = (await rows(`SELECT * FROM commerce_subscriptions WHERE id=:id AND partner_id=:partnerId ${lock ? 'FOR UPDATE' : ''}`, { id, partnerId }, t))[0];
  if (!sub) throw notFound('Assinatura');
  return sub;
};
export async function listCustomers(partnerId, { q = '', page = 1, pageSize = 30 } = {}) {
  const filters = { partnerId, q: `%${q.replace(/[\\%_]/g, x => `\\${x}`)}%`, limit: pageSize, offset: (page - 1) * pageSize };
  const [data, count] = await Promise.all([
    rows(`SELECT c.id,c.name,c.email,c.phone,c.notes,c.created_at AS "createdAt",
      (SELECT count(*)::int FROM commerce_subscription_slots sl JOIN commerce_subscriptions s ON sl.subscription_id=s.id
       WHERE s.customer_id=c.id AND sl.released_at IS NULL) AS "linkedDevices"
       FROM commerce_customers c WHERE c.partner_id=:partnerId AND (c.name ILIKE :q OR c.email ILIKE :q OR c.phone ILIKE :q)
       ORDER BY c.created_at DESC,c.id DESC LIMIT :limit OFFSET :offset`, filters),
    rows(`SELECT count(*)::int AS count FROM commerce_customers c WHERE c.partner_id=:partnerId
      AND (c.name ILIKE :q OR c.email ILIKE :q OR c.phone ILIKE :q)`, filters),
  ]);
  return { data, total: count[0]?.count ?? 0, page, pageSize };
}
export async function createCustomer(partnerId, input, actor) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner || !['reseller','both'].includes(partner.kind)) throw fail(422,'NOT_A_RESELLER','Selecione uma revenda válida.');
  return sequelize.transaction(async t => {
    const c = (await rows(`INSERT INTO commerce_customers(partner_id,name,email,phone,notes)
      VALUES(:partnerId,:name,:email,:phone,:notes) RETURNING id,name,email,phone,notes`, {
      partnerId, name: input.name.trim(), email: input.email ?? null, phone: input.phone ?? null, notes: input.notes ?? null,
    }, t))[0];
    await audit({ actor, action: 'commerce.customer.create', entityType: 'commerce_customer', entityId: c.id, metadata: { partnerId }, transaction: t });
    return c;
  });
}
export async function getCustomer(partnerId, id) {
  const customer = await assertOwnedCustomer(id, partnerId);
  const subscriptions = await rows(`SELECT s.id,s.kind,s.state,s.billing_mode AS "billingMode",s.slots_snapshot AS "slots",
      s.price_cents_snapshot AS "priceCents",s.next_due_at AS "nextDueAt",p.name AS "planName",
      (SELECT count(*)::int FROM commerce_subscription_slots sl WHERE sl.subscription_id=s.id AND sl.released_at IS NULL) AS "usedSlots"
    FROM commerce_subscriptions s JOIN commerce_plans p ON s.plan_id=p.id
    WHERE s.partner_id=:partnerId AND s.customer_id=:id ORDER BY s.created_at DESC`, { id, partnerId });
  return { customer, subscriptions };
}
export async function updateCustomer(partnerId, id, input, actor) {
  return sequelize.transaction(async t => {
    await assertOwnedCustomer(id, partnerId, t);
    const data = { partnerId, id, ...input };
    const sets = Object.keys(input).map(k => `${({name:'name',email:'email',phone:'phone',notes:'notes'})[k]} = :${k}`).join(',');
    const changed = (await rows(`UPDATE commerce_customers SET ${sets},updated_at=now() WHERE id=:id AND partner_id=:partnerId
      RETURNING id,name,email,phone,notes`, data, t))[0];
    await audit({actor, action:'commerce.customer.update', entityType:'commerce_customer',entityId:id,metadata:{partnerId,fields:Object.keys(input)},transaction:t});
    return changed;
  });
}
export async function listPlans({ partnerId = null, kind = 'customer' } = {}) {
  return rows(`SELECT id,kind,name,price_cents AS "priceCents",period_months AS "periodMonths",
    billing_mode AS "billingMode",included_slots AS "includedSlots",allow_extra AS "allowExtra",
    allow_resell AS "allowResell",overage_cents AS "overageCents",grace_days AS "graceDays",active,version,
    owner_partner_id AS "ownerPartnerId"
    FROM commerce_plans WHERE kind=:kind AND (owner_partner_id=:partnerId OR (owner_partner_id IS NULL AND :kind='master'))
    ORDER BY created_at DESC`, {partnerId,kind});
}
export async function createPlan({partnerId = null, kind, input, actor}) {
  return sequelize.transaction(async t => {
    const row = (await rows(`INSERT INTO commerce_plans(owner_partner_id,kind,name,price_cents,period_months,
      billing_mode,included_slots,allow_extra,allow_resell,overage_cents,grace_days)
      VALUES(:partnerId,:kind,:name,:priceCents,:periodMonths,:billingMode,:includedSlots,:allowExtra,:allowResell,:overageCents,:graceDays)
      RETURNING id,kind,name`, {partnerId,kind,...input}, t))[0];
    await audit({actor,action:'commerce.plan.create',entityType:'commerce_plan',entityId:row.id,metadata:{partnerId,kind},transaction:t});
    return row;
  });
}
export async function createCustomerSubscription(partnerId, customerId, planId, actor) {
  return sequelize.transaction(async t => {
    await assertOwnedCustomer(customerId, partnerId, t);
    const p = (await rows(`SELECT * FROM commerce_plans WHERE id=:planId AND kind='customer' AND owner_partner_id=:partnerId
      AND active=true`, {planId,partnerId}, t))[0];
    if (!p) throw notFound('Plano de cliente');
    const sub = (await rows(`INSERT INTO commerce_subscriptions(partner_id,customer_id,plan_id,kind,state,billing_mode,
      slots_snapshot,price_cents_snapshot,period_months_snapshot,grace_days_snapshot)
      VALUES(:partnerId,:customerId,:planId,'customer','draft',:billingMode,:includedSlots,:priceCents,:periodMonths,:graceDays)
      RETURNING id,state`, {partnerId,customerId,planId,billingMode:p.billing_mode,includedSlots:p.included_slots,
        priceCents:p.price_cents,periodMonths:p.period_months,graceDays:p.grace_days}, t))[0];
    await audit({actor,action:'commerce.subscription.draft',entityType:'commerce_subscription',entityId:sub.id,metadata:{partnerId,customerId,planId},transaction:t});
    return {...sub, message:'Assinatura comercial em rascunho; não ativa o aplicativo nem gera cobrança.'};
  });
}
export async function listSlots(partnerId, subscriptionId) {
  await assertSubscription(subscriptionId,partnerId);
  return rows(`SELECT mac,activation_id AS "activationId",linked_at AS "linkedAt" FROM commerce_subscription_slots
    WHERE subscription_id=:subscriptionId AND partner_id=:partnerId AND released_at IS NULL ORDER BY linked_at`,{subscriptionId,partnerId});
}
/** Vincula somente uma ativação já existente e autorizada. Não inventa licença ou libera conteúdo. */
export async function linkExistingActivation(partnerId, subscriptionId, macInput, actor) {
  const mac=normalizeMac(macInput);
  if (!mac) throw fail(422,'INVALID_MAC','MAC inválido.');
  try {
    return await sequelize.transaction(async t => {
      const s=await assertSubscription(subscriptionId,partnerId,t,true);
      if(s.kind!=='customer' || !['active','past_due'].includes(s.state))
        throw fail(409,'SUBSCRIPTION_NOT_ACTIVE','Assinatura comercial não está ativa.');
      const linked = (await rows(`SELECT count(*)::int AS n FROM commerce_subscription_slots
        WHERE subscription_id=:subscriptionId AND released_at IS NULL`,{subscriptionId},t))[0].n;
      if (availableSlots(s.slots_snapshot,linked)===0) throw fail(409,'NO_FREE_SLOTS','Todas as vagas deste plano já estão ocupadas.');
      const activation=(await rows(`SELECT a.id FROM activations a LEFT JOIN licenses l
        ON l.id=COALESCE(a.granted_license_id,a.license_id)
        WHERE a.mac=:mac AND a.status='active' AND (a.partner_id=:partnerId OR l.owner_partner_id=:partnerId)
          AND (l.id IS NULL OR (l.status='active' AND (l.expires_at IS NULL OR l.expires_at>now())))
        ORDER BY a.activated_at DESC LIMIT 1`,{mac,partnerId},t))[0];
      if (!activation) throw fail(403,'ACTIVATION_NOT_OWNED','Ative a TV pelo processo atual ou verifique seu direito sobre esta ativação.');
      const slot = (await rows(`INSERT INTO commerce_subscription_slots(subscription_id,partner_id,mac,activation_id)
        VALUES(:subscriptionId,:partnerId,:mac,:activationId)
        RETURNING id,mac,activation_id AS "activationId"`,{subscriptionId,partnerId,mac,activationId:activation.id},t))[0];
      await audit({actor,action:'commerce.slot.link',entityType:'commerce_subscription',entityId:subscriptionId,
        metadata:{partnerId,mac,activationId:activation.id},transaction:t});
      return slot;
    });
  } catch(e) {
    if (e instanceof UniqueConstraintError || e?.parent?.code === '23505') throw fail(409,'SLOT_ALREADY_USED','Esta TV já está vinculada a um plano.');
    throw e;
  }
}
export async function releaseSlot(partnerId,subscriptionId,macInput,actor){
  const mac=normalizeMac(macInput); if(!mac) throw fail(422,'INVALID_MAC','MAC inválido.');
  return sequelize.transaction(async t=>{
    await assertSubscription(subscriptionId,partnerId,t,true);
    const changed=(await rows(`UPDATE commerce_subscription_slots SET released_at=now()
      WHERE partner_id=:partnerId AND subscription_id=:subscriptionId AND mac=:mac AND released_at IS NULL RETURNING id`,{partnerId,subscriptionId,mac},t))[0];
    if(!changed) throw notFound('Vaga ocupada');
    await audit({actor,action:'commerce.slot.release',entityType:'commerce_subscription',entityId:subscriptionId,metadata:{partnerId,mac},transaction:t});
    return {released:true,notice:'Vaga comercial liberada. A licença atual da TV permanece inalterada.'};
  });
}
/** Aprovação apenas comercial e auditada. Nenhum status de licença/ativação é modificado aqui. */
export async function changeSubscriptionState(partnerId,id,state,reason,actor,{admin=false}={}){
  return sequelize.transaction(async t=>{
    const s=await assertSubscription(id,partnerId,t,true);
    if(s.kind==='master' && !admin) throw fail(403,'FORBIDDEN','Somente Superadmin aprova contratos SaaS.');
    const possible={draft:['active','cancelled'],active:['past_due','restricted','cancelled'],past_due:['active','restricted','cancelled'],restricted:['active','suspended','cancelled'],suspended:['active','cancelled'],cancelled:[]};
    if(!possible[s.state]?.includes(state)) throw fail(409,'INVALID_STATE','Transição de assinatura inválida.');
    const changed=(await rows(`UPDATE commerce_subscriptions SET state=:state,
      starts_at=CASE WHEN :state='active' THEN COALESCE(starts_at,now()) ELSE starts_at END,
      updated_at=now() WHERE id=:id AND partner_id=:partnerId RETURNING id,state`,{id,partnerId,state},t))[0];
    if(state==='cancelled' && s.kind==='customer'){
      // Libera as vagas comerciais; as licenças físicas continuam com sua validade própria.
      await rows(`UPDATE commerce_subscription_slots SET released_at=now()
        WHERE subscription_id=:id AND partner_id=:partnerId AND released_at IS NULL RETURNING id`,{id,partnerId},t);
    }
    await audit({actor,action:`commerce.subscription.${state}`,entityType:'commerce_subscription',entityId:id,
      metadata:{partnerId,previous:s.state,reason},transaction:t});
    return {...changed,notice:'Estado comercial alterado. Pagamentos, licenças e permissões técnicas não foram modificados.'};
  });
}
export async function createMasterSubscription(subjectPartnerId, planId, actor) {
  return sequelize.transaction(async t=>{
    const p=(await rows(`SELECT * FROM commerce_plans WHERE id=:planId AND kind='master' AND active=true`,{planId},t))[0];
    if(!p) throw notFound('Plano SaaS');
    const target=await Partner.findByPk(subjectPartnerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(!target || !['reseller','both'].includes(target.kind)) throw notFound('Master/Revenda');
    const sub=(await rows(`INSERT INTO commerce_subscriptions(partner_id,subject_partner_id,plan_id,kind,state,billing_mode,
      slots_snapshot,price_cents_snapshot,period_months_snapshot,grace_days_snapshot)
      VALUES(:subjectPartnerId,:subjectPartnerId,:planId,'master','draft',:billingMode,:includedSlots,:priceCents,:periodMonths,:graceDays)
      RETURNING id,state`,{subjectPartnerId,planId,billingMode:p.billing_mode,includedSlots:p.included_slots,
        priceCents:p.price_cents,periodMonths:p.period_months,graceDays:p.grace_days},t))[0];
    await audit({actor,action:'commerce.master.draft',entityType:'commerce_subscription',entityId:sub.id,
      metadata:{subjectPartnerId,planId},transaction:t});
    return {...sub,notice:'Contrato SaaS em rascunho; não libera acesso ou cobrança sem a etapa financeira.'};
  });
}
export async function masterContract(subjectPartnerId){
  return rows(`SELECT s.id,s.state,s.billing_mode AS "billingMode",s.slots_snapshot AS "includedSlots",
    s.price_cents_snapshot AS "priceCents",s.next_due_at AS "nextDueAt",p.name AS "planName"
    FROM commerce_subscriptions s JOIN commerce_plans p ON p.id=s.plan_id WHERE s.kind='master' AND
      s.subject_partner_id=:subjectPartnerId ORDER BY s.created_at DESC`,{subjectPartnerId});
}
