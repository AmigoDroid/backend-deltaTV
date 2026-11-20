import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize, Partner, PartnerServicePlan, ServicePlanCatalog } from '../../db/models/index.js';
import { effectivePartnerStatus } from '../access/access.policy.js';
import { audit } from '../../shared/audit.js';
import {assertPublicPlan,isHiddenNetworkPlan} from '../service-plans/network-plan-visibility.js';
import { AppError } from '../../shared/errors.js';
import { calculateChargePricing, DEFAULT_CAPS, DEFAULT_SETTINGS, localDate, validateSettings } from './charge-pricing.js';
const sql=(statement,replacements={},transaction)=>sequelize.query(statement,{type:QueryTypes.SELECT,replacements,...(transaction?{transaction}:{})});
const fail=(status,code,message)=>{throw new AppError(status,code,message)};
const columns={
 lateFeeEnabled:'late_fee_enabled',lateFeePct:'late_fee_pct',interestMonthlyPct:'interest_monthly_pct',
 toleranceDays:'tolerance_days',earlyDiscountEnabled:'early_discount_enabled',earlyDiscountType:'early_discount_type',
 earlyDiscountValue:'early_discount_value',earlyMinDaysBefore:'early_min_days_before',earlyStartsAt:'early_starts_at',
 earlyEndsAt:'early_ends_at',earlyPlanKeys:'early_plan_keys',defaultDiscountDays:'default_discount_days',
 minChargeCents:'min_charge_cents',shortCycleDays:'short_cycle_days',
};
const configOut=row=>row?Object.fromEntries(Object.entries(columns).map(([k,col])=>[k,typeof row[col]==='string' && ['lateFeePct','interestMonthlyPct','earlyDiscountValue','minChargeCents'].includes(k)?Number(row[col]):row[col]])):{...DEFAULT_SETTINGS};
export async function getCaps(transaction){
 const [r]=await sql('SELECT late_fee_pct,interest_monthly_pct,conditions_text FROM platform_billing_caps WHERE id=1',{},transaction);
 return r?{lateFeePct:Number(r.late_fee_pct),interestMonthlyPct:Number(r.interest_monthly_pct),conditionsText:r.conditions_text}:{...DEFAULT_CAPS};
}
export async function getSettings(adminId,transaction){
 const [r]=await sql('SELECT * FROM admin_billing_settings WHERE admin_user_id=CAST(:adminId AS uuid)',{adminId},transaction);
 const [caps,raw]=await Promise.all([getCaps(transaction),Promise.resolve(configOut(r))]);
 // Se a plataforma reduzir um teto depois, nenhuma rede pode continuar cobrando acima dele.
 return {settings:{...raw,lateFeePct:Math.min(Number(raw.lateFeePct),caps.lateFeePct),
   interestMonthlyPct:Math.min(Number(raw.interestMonthlyPct),caps.interestMonthlyPct)},caps};
}
export async function saveSettings(adminId,values,actor){
 return sequelize.transaction(async t=>{
  await sql('SELECT id FROM admin_users WHERE id=CAST(:adminId AS uuid) FOR UPDATE',{adminId},t);
  const old=await getSettings(adminId,t);const caps=old.caps;
  let settings;
  try{settings=validateSettings({...old.settings,...values},caps)}catch(e){fail(422,'INVALID_BILLING_SETTINGS',e.message)}
  const fields=Object.keys(columns),params={adminId,...settings};
  const all=fields.map(k=>columns[k]);
  params.earlyPlanKeys=JSON.stringify(settings.earlyPlanKeys);
  await sql(`INSERT INTO admin_billing_settings(admin_user_id,${all.join(',')})
    VALUES(CAST(:adminId AS uuid),${fields.map(k=>k==='earlyPlanKeys'?'CAST(:earlyPlanKeys AS jsonb)':`:${k}`).join(',')})
    ON CONFLICT(admin_user_id) DO UPDATE SET ${all.map(c=>`${c}=EXCLUDED.${c}`).join(',')},updated_at=now()`,params,t);
  await audit({actor,action:'network.finance.pricing.settings',entityType:'admin_user',entityId:adminId,
    metadata:{before:old.settings,after:settings},transaction:t});
  return {settings,caps};
 });
}
export async function saveCaps(values,actor){
 return sequelize.transaction(async t=>{
  const previous=await getCaps(t);const next={...previous,...values};
  try{validateSettings({...DEFAULT_SETTINGS,lateFeePct:0,interestMonthlyPct:0},next)}
  catch(e){fail(422,'INVALID_CAPS',e.message)}
  for(const k of ['lateFeePct','interestMonthlyPct']){
    if(!Number.isFinite(Number(next[k]))||Number(next[k])<0||Number(next[k])>100)fail(422,'INVALID_CAPS','Teto deve ficar entre 0% e 100%.');
  }
  await sql('UPDATE platform_billing_caps SET late_fee_pct=:lateFeePct,interest_monthly_pct=:interestMonthlyPct,conditions_text=:conditionsText,updated_at=now() WHERE id=1',next,t);
  await audit({actor,action:'network.finance.platform.caps',entityType:'platform_billing_caps',entityId:null,metadata:{before:previous,after:next},transaction:t});
  return next;
 });
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Todos os preços, datas, identidade e limites vêm do banco. Somente ajustes com papel delegado entram aqui. */
export async function quoteNetworkCharge(adminId,{partnerId,kind,planTo,manualDiscount=null,waiver=null},actor={}, {transaction,now=new Date(),source='admin'}={}){
 const partner=await Partner.findOne({where:{id:partnerId,ownerAdminId:adminId},transaction});
 if(!partner||partner.status==='deleted')fail(404,'NOT_FOUND','Parceiro fora desta rede.');
 const [plan,current,{settings,caps}]=await Promise.all([
   ServicePlanCatalog.findOne({where:{key:planTo,ownerAdminId:adminId,active:true,deletedAt:null},transaction}),
   PartnerServicePlan.findByPk(partnerId,{transaction}),getSettings(adminId,transaction),
 ]);
 if(source==='partner')assertPublicPlan(plan);
 if(!plan||(plan.audience!=='both'&&plan.audience!==partner.kind))fail(422,'PLAN_NOT_IN_NETWORK','Plano incompatível ou fora desta rede.');
 if(kind==='renewal'&&current?.tier&&current.tier!==planTo)fail(422,'PLAN_MISMATCH','Renovação exige o plano atual.');
 if(kind==='upgrade'&&current?.tier===planTo)fail(422,'NOT_AN_UPGRADE','Selecione outro plano.');
 if(!Number.isInteger(plan.monthlyPriceCents)||plan.monthlyPriceCents<=0)fail(422,'FREE_PLAN','Plano gratuito não gera cobrança.');
 const old= current?.tier? await ServicePlanCatalog.findOne({where:{key:current.tier,ownerAdminId:adminId},transaction}):null;
 if(kind==='upgrade'&&!old)fail(422,'CURRENT_PLAN_MISSING','Não foi possível calcular a base proporcional sem o plano antigo.');
 const manual=manualDiscount?{...manualDiscount,actorId:actor?.id||null}:null;
 const forgiven=waiver?{...waiver,actorId:actor?.id||null}:null;
 const effective=effectivePartnerStatus(partner,now);
 let breakdown;
 try{breakdown=calculateChargePricing({kind,planPriceCents:plan.monthlyPriceCents,oldPlanPriceCents:partner.monthlyFeeCents||old?.monthlyPriceCents||0,
   validityDays:plan.validityDays,endsAt:partner.endsAt,effectiveStatus:effective,planKey:planTo,
   now,settings,caps,manual,waiver:forgiven});}
 catch(e){fail(422,'INVALID_CHARGE_PRICING',e.message)}
 const stable={...breakdown};delete stable.chargedAt;
 const previewFingerprint=fingerprint({partnerId,kind,planTo,endsAt:partner.endsAt?.toISOString?.()||String(partner.endsAt),
   status:partner.status,day:localDate(now),breakdown:stable});
 return {previewFingerprint,breakdown,amountCents:breakdown.totalCents,partnerId,planFrom:current?.tier||null,
   planTo,conditions:conditionsText({settings,caps}),expiresAt:breakdown.expiresAt||null};
}
export function conditionsText({settings,caps}){
 return `Multa: ${settings.lateFeeEnabled?settings.lateFeePct:0}% única; juros simples: ${settings.lateFeeEnabled?settings.interestMonthlyPct:0}% ao mês; tolerância: ${settings.toleranceDays} dia(s).${settings.earlyDiscountEnabled?` Desconto antecipado: ${settings.earlyDiscountType==='percent'?`${settings.earlyDiscountValue}%`:`${Number(settings.earlyDiscountValue)/100} reais`} com ${settings.earlyMinDaysBefore} dia(s) de antecedência.`:''}${caps.conditionsText?` ${caps.conditionsText}`:''}`;
}
export async function partnerPricingInfo(partnerId){
 const partner=await Partner.findByPk(partnerId);
 if(!partner||!partner.ownerAdminId)fail(404,'NOT_FOUND','Nenhuma rede financeira vinculada.');
 const current=await PartnerServicePlan.findByPk(partnerId);
 if(!current)fail(404,'PLAN_MISSING','Plano não encontrado.');
 const {settings,caps}=await getSettings(partner.ownerAdminId);
 const currentCatalog=await ServicePlanCatalog.findOne({where:{key:current.tier,ownerAdminId:partner.ownerAdminId},attributes:['name','hiddenFromNetwork','active']});
 if(isHiddenNetworkPlan(currentCatalog))return {planName:currentCatalog.name,renewalAvailable:false,
   reason:'Plano concedido pela administração. A renovação é realizada apenas pelo administrador.',
   conditions:conditionsText({settings,caps})};
 const quote=await quoteNetworkCharge(partner.ownerAdminId,{partnerId,kind:'renewal',planTo:current.tier}, {},{source:'partner'});
 // A data da campanha não é necessariamente o próprio vencimento: um mínimo
 // de N dias antecipados encerra o benefício N dias antes.
 const earlyCutoff=partner.endsAt&&settings.earlyDiscountEnabled?
   new Date(new Date(partner.endsAt).getTime()-settings.earlyMinDaysBefore*86400_000):null;
 const earlyDiscountDeadline=earlyCutoff && settings.earlyEndsAt
   ?new Date(Math.min(earlyCutoff.getTime(),new Date(settings.earlyEndsAt).getTime())):earlyCutoff;
 const b=quote.breakdown;
 return {planName:currentCatalog?.name||current.tier,renewalAvailable:true,amountCents:quote.amountCents,breakdown:{
   baseCents:b.baseCents,earlyDiscountCents:b.earlyDiscountCents,
   lateFeeCents:b.lateFeeCents,interestCents:b.interestCents,
   daysLate:b.daysLate,totalCents:b.totalCents},conditions:conditionsText({settings,caps}),
   earlyDiscountDeadline};
}
