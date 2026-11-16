import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { invalidatePlan } from '../service-plans/plan.service.js';
import { assertPackageInput, technicalTierForPackage, packageSnapshotFromRow } from './package.rules.js';
import { applyServicePackageToPartner } from './package.apply.js';

const read=(sql,replacements={},t)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction:t});
const run=(sql,replacements={},t)=>sequelize.query(sql,{replacements,transaction:t});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;
const notFound=()=>{throw new AppError(404,'SERVICE_PACKAGE_NOT_FOUND','Pacote de Serviço não encontrado.');};

export async function listServicePackages(){
 return read(`SELECT p.code,p.name,p.wholesale_cents,p.min_resale_cents,p.active,p.revision,
   p.service_tier,p.max_dns,p.activation_limit,p.auto_failover,p.auto_priority,p.email_alerts,p.detailed_history,
   (SELECT count(*)::int FROM partner_service_package_assignments a WHERE a.package_code=p.code) AS assigned_count,
   (SELECT count(*)::int FROM partner_portal_access_contracts ac WHERE ac.plan_code=p.code) AS legacy_contract_count
  FROM partner_portal_sales_plans p WHERE p.service_tier IS NOT NULL
  ORDER BY p.active DESC,p.name`);
}
export async function getServicePackage(code,t){
 const p=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:code',{code},t);
 if(!p)notFound();return p;
}
/** One write endpoint updates both physical representations transactionally.
 * Existing assignments are snapshots and must never be altered by catalog edits. */
export async function saveServicePackage(input,actor){
 try{assertPackageInput(input);}catch(e){throw new AppError(422,'SERVICE_PACKAGE_INVALID',e.message);}
 let row;
 await sequelize.transaction(async t=>{
  await run('SELECT pg_advisory_xact_lock(99111712)',{},t);
  const prior=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:code FOR UPDATE',{code:input.code},t);
  // A dedicated technical tier avoids rewriting a shared legacy tier (e.g. partner_premium).
  const tier=technicalTierForPackage(input.code);
  const technical=await one('SELECT key,system FROM service_plan_catalogs WHERE key=:tier',{tier},t);
  if(technical?.system)throw new AppError(409,'SERVICE_PACKAGE_TIER_CONFLICT','Tier técnico protegido.');
  await run(`INSERT INTO service_plan_catalogs(key,name,description,audience,monthly_price_cents,max_servers,
     auto_failover,auto_priority,email_alerts,detailed_history,active,system,sort_order)
    VALUES (:tier,:name,'Gerenciado por Pacotes de Serviço','content',:wholesaleCents,:maxDns,
     :autoFailover,:autoPriority,:emailAlerts,:detailedHistory,:active,false,100)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name,monthly_price_cents=excluded.monthly_price_cents,
     max_servers=excluded.max_servers,auto_failover=excluded.auto_failover,auto_priority=excluded.auto_priority,
     email_alerts=excluded.email_alerts,detailed_history=excluded.detailed_history,active=excluded.active`,{
     ...input,tier},t);
  row=await one(`INSERT INTO partner_portal_sales_plans(code,name,wholesale_cents,min_resale_cents,active,service_tier,
    max_dns,activation_limit,auto_failover,auto_priority,email_alerts,detailed_history)
    VALUES(:code,:name,:wholesaleCents,:minResaleCents,:active,:tier,
      :maxDns,:activationLimit,:autoFailover,:autoPriority,:emailAlerts,:detailedHistory)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name,wholesale_cents=excluded.wholesale_cents,
      min_resale_cents=excluded.min_resale_cents,active=excluded.active,service_tier=excluded.service_tier,
      max_dns=excluded.max_dns,activation_limit=excluded.activation_limit,auto_failover=excluded.auto_failover,
      auto_priority=excluded.auto_priority,email_alerts=excluded.email_alerts,detailed_history=excluded.detailed_history,
      revision=partner_portal_sales_plans.revision+1,updated_at=now() RETURNING *`,{...input,tier},t);
  await audit({actor,action:'service_package.saved',entityType:'service_package',entityId:null,
   metadata:{packageCode:input.code,version:row.revision,previousVersion:prior?.revision||null,wasNew:!prior},transaction:t});
 });
 // Technical settings cache must be invalidated after commit.
 invalidatePlan();
 const [{invalidateServerPools},{clearResolutionCache}]=await Promise.all([
  import('../provider-monitor/code-pool.service.js'),import('../provider-monitor/resolve.service.js')]);
 invalidateServerPools();clearResolutionCache();
 return {package:packageSnapshotFromRow(row),active:row.active,wholesaleCents:Number(row.wholesale_cents),minResaleCents:Number(row.min_resale_cents)};
}
export async function toggleServicePackage(code,active,actor){
 const current=await getServicePackage(code);
 if(!current.service_tier)throw new AppError(409,'LEGACY_PLAN','Converta o plano antigo antes de administrá-lo como Pacote de Serviço.');
 const previous={code:current.code,name:current.name,wholesaleCents:Number(current.wholesale_cents),minResaleCents:Number(current.min_resale_cents),
  active,maxDns:current.max_dns===null?null:Number(current.max_dns),activationLimit:current.activation_limit===null?null:Number(current.activation_limit),
  autoFailover:current.auto_failover,autoPriority:current.auto_priority,emailAlerts:current.email_alerts,detailedHistory:current.detailed_history};
 return saveServicePackage(previous,actor);
}
export async function duplicateServicePackage(code,{newCode,newName},actor){
 const current=await getServicePackage(code);
 if(!current.service_tier)throw new AppError(409,'LEGACY_PLAN','O plano antigo precisa ser convertido antes de duplicar.');
 const existing=await one('SELECT code FROM partner_portal_sales_plans WHERE code=:code',{code:newCode});
 if(existing)throw new AppError(409,'PACKAGE_ALREADY_EXISTS','Já existe um pacote com este identificador.');
 return saveServicePackage({code:newCode,name:newName,wholesaleCents:Number(current.wholesale_cents),
  minResaleCents:Number(current.min_resale_cents),active:true,
  maxDns:current.max_dns===null?null:Number(current.max_dns),activationLimit:current.activation_limit===null?null:Number(current.activation_limit),
  autoFailover:current.auto_failover,autoPriority:current.auto_priority,emailAlerts:current.email_alerts,detailedHistory:current.detailed_history},actor);
}
export async function assignServicePackage(partnerId,code,actor){
 let snapshot;
 await sequelize.transaction(async t=>{
  await run('SELECT pg_advisory_xact_lock(99111712)',{},t);
  const partner=await one('SELECT id,kind,status FROM partners WHERE id=:partnerId FOR UPDATE',{partnerId},t);
  if(!partner||!['content','both'].includes(partner.kind)||partner.status==='deleted')
   throw new AppError(422,'INVALID_PARTNER','Escolha uma conta do Painel do Parceiro válida.');
  const packageRow=await getServicePackage(code,t);
  if(!packageRow.active||!packageRow.service_tier)throw new AppError(409,'INACTIVE_SERVICE_PACKAGE','Pacote de Serviço desativado ou ainda não convertido.');
  snapshot=packageSnapshotFromRow(packageRow);
  await applyServicePackageToPartner(partnerId,snapshot,t,{actorId:actor.id});
  await audit({actor,action:'service_package.assigned',entityType:'partner',entityId:partnerId,
   metadata:{packageCode:code,version:snapshot.revision},transaction:t});
 });
 invalidatePlan(partnerId);
 return {partnerId,package:snapshot};
}

/** DeltaTV-only readmodel for the partner profile; no mutation or leaked private ids. */
export async function getPartnerAssignedPackage(partnerId){
 const row=await one(`SELECT a.partner_id,a.package_code,a.package_snapshot,a.assigned_at,
  p.name AS current_name,p.active AS catalog_active
  FROM partner_service_package_assignments a
  LEFT JOIN partner_portal_sales_plans p ON p.code=a.package_code
  WHERE a.partner_id=:partnerId`,{partnerId});
 return row?{code:row.package_code,package:row.package_snapshot,
  assignedAt:row.assigned_at,catalogActive:row.catalog_active,currentName:row.current_name}:{legacy:true};
}
