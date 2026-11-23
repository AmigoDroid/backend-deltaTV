import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { invalidatePlan } from '../service-plans/plan.service.js';
import { assertPackageInput, technicalTierForPackage, packageSnapshotFromRow } from './package.rules.js';
import { applyServicePackageToPartner, assertPartnerFitsPackage } from './package.apply.js';
import { effectivePackageQuota, contractInheritsLimit, isReduction } from './package.inheritance.js';

const read=(sql,replacements={},t)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction:t});
const run=(sql,replacements={},t)=>sequelize.query(sql,{replacements,transaction:t});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;
const notFound=()=>{throw new AppError(404,'SERVICE_PACKAGE_NOT_FOUND','Pacote de Serviço não encontrado.');};

export async function listServicePackages(){
 return read(`SELECT p.code,p.name,p.wholesale_cents,p.min_resale_cents,p.active,p.revision,
   p.service_tier,p.max_dns,p.activation_limit,COALESCE(c.max_apps,0)::integer AS max_apps,p.auto_failover,p.auto_priority,p.email_alerts,p.detailed_history,
   (SELECT count(*)::int FROM partner_service_package_assignments a WHERE a.package_code=p.code) AS assigned_count,
   (SELECT count(*)::int FROM partner_portal_access_contracts ac WHERE ac.plan_code=p.code) AS legacy_contract_count
  FROM partner_portal_sales_plans p LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier WHERE p.service_tier IS NOT NULL
  ORDER BY p.active DESC,p.name`);
}
export async function getServicePackage(code,t){
 const p=await one(`SELECT p.*,COALESCE(c.max_apps,0)::integer AS max_apps FROM partner_portal_sales_plans p
  LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier WHERE p.code=:code`,{code},t);
 if(!p)notFound();return p;
}
/** Um pacote governa os recursos atuais; só o histórico comercial fica congelado. */
export async function saveServicePackage(input,actor,{create=false}={}){
 try{assertPackageInput(input);}catch(e){throw new AppError(422,'SERVICE_PACKAGE_INVALID',e.message);}
 let row,maxApps;
 await sequelize.transaction(async t=>{
  await run('SELECT pg_advisory_xact_lock(99111712)',{},t);
  // Ordem de locks igual a claims/alteração individual: parceiro antes de catálogo.
  const tier=technicalTierForPackage(input.code);
  await read(`SELECT id FROM partners WHERE id IN
    (SELECT partner_id FROM partner_service_plans WHERE tier=:tier)
    ORDER BY id FOR UPDATE`,{tier},t);
  const prior=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:code FOR UPDATE',{code:input.code},t);
  if(create&&prior)throw new AppError(409,'SERVICE_PACKAGE_ALREADY_EXISTS','Já existe um pacote com este identificador.');
  if(!create&&!prior)notFound();
  const technical=await one(`SELECT key,system,max_apps,max_servers FROM service_plan_catalogs
    WHERE key=:tier FOR UPDATE`,{tier},t);
  if(technical?.system)throw new AppError(409,'SERVICE_PACKAGE_TIER_CONFLICT','Tier técnico protegido.');
  maxApps=input.maxApps??Number(technical?.max_apps??0);
  const assigned=technical?await read(`SELECT ps.partner_id,ps.max_apps_override,ps.max_servers_override,
    a.package_code,a.package_snapshot,a.live_snapshot,ct.mode,ct.activation_limit,ct.auto_priority
    FROM partner_service_plans ps
    LEFT JOIN partner_service_package_assignments a ON a.partner_id=ps.partner_id AND a.package_code=:code
    LEFT JOIN content_partner_terms ct ON ct.partner_id=ps.partner_id
    WHERE ps.tier=:tier ORDER BY ps.partner_id`,{tier,code:input.code},t):[];
  for(const account of assigned){
   const limits=effectivePackageQuota(account,technical,{maxApps,maxDns:input.maxDns,activationLimit:input.activationLimit});
   await assertPartnerFitsPackage(account.partner_id,{
     maxApps:isReduction(limits.oldApps,limits.maxApps)?limits.maxApps:undefined,
     maxDns:isReduction(limits.oldDns,limits.maxDns)?limits.maxDns:null,
     activationLimit:isReduction(limits.oldActivation,limits.activationLimit)?limits.activationLimit:null,
   },t);
  }
  await run(`INSERT INTO service_plan_catalogs(key,name,description,audience,monthly_price_cents,max_servers,
     max_apps,auto_failover,auto_priority,email_alerts,detailed_history,active,system,sort_order)
    VALUES (:tier,:name,'Gerenciado por Pacotes de Serviço','content',:wholesaleCents,:maxDns,:maxApps,
     :autoFailover,:autoPriority,:emailAlerts,:detailedHistory,:active,false,100)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name,monthly_price_cents=excluded.monthly_price_cents,
     max_servers=excluded.max_servers,max_apps=excluded.max_apps,auto_failover=excluded.auto_failover,auto_priority=excluded.auto_priority,
     email_alerts=excluded.email_alerts,detailed_history=excluded.detailed_history,active=excluded.active`,{
     ...input,maxApps,tier},t);
  const values={...input,tier};
  row=create
   ? await one(`INSERT INTO partner_portal_sales_plans(code,name,wholesale_cents,min_resale_cents,active,service_tier,
      max_dns,activation_limit,auto_failover,auto_priority,email_alerts,detailed_history)
      VALUES(:code,:name,:wholesaleCents,:minResaleCents,:active,:tier,
        :maxDns,:activationLimit,:autoFailover,:autoPriority,:emailAlerts,:detailedHistory)
      ON CONFLICT(code) DO NOTHING RETURNING *`,values,t)
   : await one(`UPDATE partner_portal_sales_plans SET
      name=:name,wholesale_cents=:wholesaleCents,min_resale_cents=:minResaleCents,
      active=:active,service_tier=:tier,max_dns=:maxDns,activation_limit=:activationLimit,
      auto_failover=:autoFailover,auto_priority=:autoPriority,email_alerts=:emailAlerts,
      detailed_history=:detailedHistory,revision=revision+1,updated_at=now()
      WHERE code=:code RETURNING *`,values,t);
  // Em criação concorrente, a restrição única prevalece; nenhuma linha antiga é reescrita.
  if(!row){
    if(create)throw new AppError(409,'SERVICE_PACKAGE_ALREADY_EXISTS','Já existe um pacote com este identificador.');
    notFound();
  }
  // Atribuições não perdem seu snapshot histórico. A cópia viva acompanha
  // todas as edições técnicas, incluindo aumento de vagas e benefícios.
  const updatedSnapshot=packageSnapshotFromRow({...row,max_apps:maxApps});
  for(const account of assigned){
   if(!account.package_code)continue;
   const previous=account.live_snapshot||account.package_snapshot;
   if(contractInheritsLimit(account)){
    await run(`UPDATE content_partner_terms SET mode=:mode,activation_limit=:limit
      WHERE partner_id=:partnerId`,{
      partnerId:account.partner_id,mode:updatedSnapshot.activationLimit==null?'fixed_unlimited':'fixed_limited',
      limit:updatedSnapshot.activationLimit},t);
   }
   if(account.auto_priority!=null && previous?.autoPriority===account.auto_priority){
    await run(`UPDATE content_partner_terms SET auto_priority=:priority WHERE partner_id=:partnerId`,{
      partnerId:account.partner_id,priority:updatedSnapshot.autoPriority},t);
   }
   await run(`UPDATE partner_service_package_assignments SET live_snapshot=
     CAST(:snapshot AS jsonb) || jsonb_build_object('explicitOverrides',
       COALESCE(live_snapshot->'explicitOverrides','{}'::jsonb))
     WHERE partner_id=:partnerId AND package_code=:code`,{
     snapshot:JSON.stringify(updatedSnapshot),partnerId:account.partner_id,code:input.code},t);
  }
  await audit({actor,action:'service_package.saved',entityType:'service_package',entityId:null,
   metadata:{packageCode:input.code,version:row.revision,previousVersion:prior?.revision||null,wasNew:!prior},transaction:t});
 });
 // Technical settings cache must be invalidated after commit.
 invalidatePlan();
 const [{invalidateServerPools},{clearResolutionCache}]=await Promise.all([
  import('../provider-monitor/code-pool.service.js'),import('../provider-monitor/resolve.service.js')]);
 invalidateServerPools();clearResolutionCache();
 return {package:packageSnapshotFromRow({...row,max_apps:maxApps}),active:row.active,wholesaleCents:Number(row.wholesale_cents),minResaleCents:Number(row.min_resale_cents)};
}
export function createServicePackage(input,actor){return saveServicePackage(input,actor,{create:true});}
export async function toggleServicePackage(code,active,actor){
 const current=await getServicePackage(code);
 if(!current.service_tier)throw new AppError(409,'LEGACY_PLAN','Converta o plano antigo antes de administrá-lo como Pacote de Serviço.');
 const previous={code:current.code,name:current.name,wholesaleCents:Number(current.wholesale_cents),minResaleCents:Number(current.min_resale_cents),
  active,maxDns:current.max_dns===null?null:Number(current.max_dns),activationLimit:current.activation_limit===null?null:Number(current.activation_limit),maxApps:Number(current.max_apps??0),
  autoFailover:current.auto_failover,autoPriority:current.auto_priority,emailAlerts:current.email_alerts,detailedHistory:current.detailed_history};
 return saveServicePackage(previous,actor);
}
export async function duplicateServicePackage(code,{newCode,newName},actor){
 const current=await getServicePackage(code);
 if(!current.service_tier)throw new AppError(409,'LEGACY_PLAN','O plano antigo precisa ser convertido antes de duplicar.');
 const existing=await one('SELECT code FROM partner_portal_sales_plans WHERE code=:code',{code:newCode});
 if(existing)throw new AppError(409,'PACKAGE_ALREADY_EXISTS','Já existe um pacote com este identificador.');
 return createServicePackage({code:newCode,name:newName,wholesaleCents:Number(current.wholesale_cents),
  minResaleCents:Number(current.min_resale_cents),active:true,
  maxDns:current.max_dns===null?null:Number(current.max_dns),activationLimit:current.activation_limit===null?null:Number(current.activation_limit),maxApps:Number(current.max_apps??0),
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
 const row=await one(`SELECT a.partner_id,a.package_code,a.package_snapshot,a.live_snapshot,a.assigned_at,
  p.name AS current_name,p.active AS catalog_active,ps.tier AS assigned_tier
  FROM partner_service_package_assignments a
  LEFT JOIN partner_portal_sales_plans p ON p.code=a.package_code
  LEFT JOIN partner_service_plans ps ON ps.partner_id=a.partner_id
  WHERE a.partner_id=:partnerId`,{partnerId});
 if(!row||row.assigned_tier!==(row.live_snapshot||row.package_snapshot)?.tier)return {legacy:true};
 const {getServicePlan}=await import('../service-plans/plan.service.js');
 const current=await getServicePlan(partnerId);
 const live={...(row.live_snapshot||row.package_snapshot),...current.features,
   name:row.current_name||current.planName,maxDns:current.features.maxServers,
   maxApps:current.features.maxApps};
 return {code:row.package_code,package:live,historicalPackage:row.package_snapshot,
   assignedAt:row.assigned_at,catalogActive:row.catalog_active,currentName:row.current_name};
}
