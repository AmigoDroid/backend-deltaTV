import {ensurePackageSeller} from '../service-packages/package.apply.js';
import { Op } from 'sequelize';
import {sequelize,Partner,AdminUser,PartnerServicePlan,ContentPartnerTerms,ServicePlanCatalog} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import { enforceLimit } from './permissions.js';
import { expirationFromPlan, networkSlug, planBenefits } from './plan-entitlements.js';

export const planCompatible=(plan,kind='content')=>Boolean(plan?.active&&(plan.audience==='both'||plan.audience===kind));
export async function scopedPlan(ownerId,key,kind='content',transaction){
 const plan=await ServicePlanCatalog.findOne({where:{ownerAdminId:ownerId,key,deletedAt:null},transaction,lock:transaction?.LOCK?.UPDATE});
 if(!planCompatible(plan,kind))throw new AppError(422,'PLAN_NOT_IN_NETWORK','Plano indisponível nesta rede.');
 if(!Number.isInteger(plan.monthlyPriceCents)||plan.monthlyPriceCents<0)
   throw new AppError(409,'PLAN_PRICE_REQUIRED','Configure o preço do plano antes do cadastro (R$ 0 é permitido).');
 return plan;
}
export function checkPlanCaps(plan,limits={}) {
 const {dnsLimit,activationLimit}=planBenefits(plan);
 const maxDns=limits.maxDnsPerCode, maxActivations=limits.maxActivationsPerPartner;
 if(maxDns!=null && (dnsLimit==null||dnsLimit===0||dnsLimit>maxDns))
   throw new AppError(403,'DNS_QUOTA_EXCEEDED','Este plano excede o limite de DNS autorizado à sua rede.');
 if(maxActivations!=null && (activationLimit==null||activationLimit>maxActivations))
   throw new AppError(403,'ACTIVATION_QUOTA_EXCEEDED','Este plano excede o limite de ativações autorizado à sua rede.');
}
export async function provisionNetworkAccount({ownerId,actor,plan,name,email,passwordHash,kind='content',limits={},transaction}){
 if(!planCompatible(plan,kind))throw new AppError(422,'PLAN_NOT_IN_NETWORK','Plano indisponível para a conta.');
 checkPlanCaps(plan,limits);
 const quotaKey=kind==='reseller'?'maxResellers':'maxPartners';
 const kinds=kind==='reseller'?['reseller','both']:['content','both'];
 const count=await Partner.count({where:{ownerAdminId:ownerId,kind:{[Op.in]:kinds},status:{[Op.ne]:'deleted'}},transaction});
 enforceLimit(limits[quotaKey],count,kind==='reseller'?'RESELLER_QUOTA_EXCEEDED':'PARTNER_QUOTA_EXCEEDED');
 const start=new Date(), benefits=planBenefits(plan);
 const p=await Partner.create({name:name.trim(),slug:networkSlug(),kind,ownerAdminId:ownerId,
  contactName:name.trim(),contactEmail:email.trim().toLowerCase(),startsAt:start,endsAt:expirationFromPlan(plan,start),
  status:benefits.monthlyFeeCents===0?'active':'suspended',
  statusReason:benefits.monthlyFeeCents===0?null:'awaiting_payment',billingModel:'fixed',monthlyFeeCents:benefits.monthlyFeeCents,deviceLimit:benefits.activationLimit,
  dueDay:10,graceDays:5,suspendPolicy:'auto_after_grace'}, {transaction});
 await PartnerServicePlan.create({partnerId:p.id,tier:plan.key,maxServersOverride:null,
  autoFailoverOverride:null,autoPriorityOverride:null,emailAlertsOverride:null,detailedHistoryOverride:null},{transaction});
 // O plano é a fonte técnica; alterações futuras herdam os limites contratados.
 await sequelize.query('UPDATE partner_service_plans SET activation_limit_inherited=true WHERE partner_id=:id',{
  replacements:{id:p.id},transaction});
 if(kind!=='reseller')await ContentPartnerTerms.create({partnerId:p.id,
  mode:benefits.activationLimit==null?'fixed_unlimited':'fixed_limited',fixedFeeCents:benefits.monthlyFeeCents,
  activationLimit:benefits.activationLimit,licensePolicy:'partner_only',creditsPerActivation:1,
  autoPriority:benefits.autoPriority,allowWebIssuance:false},{transaction});
 if(ownerId===null&&plan.canResellPanel)await ensurePackageSeller(p.id,transaction);
 const u=await AdminUser.create({name:name.trim(),email:email.trim().toLowerCase(),passwordHash,
  role:'partner',partnerId:p.id,status:'active'},{transaction});
 await audit({actor,action:'network.partner.create',entityType:'partner',entityId:p.id,
  metadata:{ownerAdminId:ownerId,planKey:plan.key,userId:u.id,feeCents:benefits.monthlyFeeCents,kind},transaction});
 return {partner:p,user:u};
}
export async function lockNetworkOwner(ownerId,transaction){
 await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key,0))',{
  replacements:{key:`network:${ownerId}`},transaction});
}
