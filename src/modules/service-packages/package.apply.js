import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { packageSnapshotFromRow } from './package.rules.js';
import { assertNoSlotDowngrade } from '../client-apps/app-entitlement.js';

const read=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction});
const run=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,transaction});
const one=async(sql,p={},t)=>(await read(sql,p,t))[0]||null;

/** No destructive downgrade: the master retains used DNS and activations.
 * Called from package assignments and invite acceptance inside ONE transaction. */
export async function assertPartnerFitsPackage(partnerId, snapshot, transaction){
 if(snapshot.maxApps!==undefined && snapshot.maxApps!==null)await assertNoSlotDowngrade(partnerId,snapshot.maxApps,transaction);
 if(snapshot.maxDns!==null){
  const tooMany=await one(`SELECT c.code,count(pool.id)::int AS used
   FROM partner_codes c JOIN code_server_pools pool ON pool.code_id=c.id
   WHERE c.partner_id=:partnerId AND c.status='active'
   GROUP BY c.id,c.code HAVING count(pool.id) > :maxDns LIMIT 1`,
   {partnerId,maxDns:snapshot.maxDns},transaction);
  if(tooMany)throw new AppError(409,'SERVICE_PACKAGE_DNS_EXCEEDED',
   `O código ${tooMany.code} já usa ${tooMany.used} DNS. Escolha outro pacote sem remover os DNS atuais.`);
 }
 if(snapshot.activationLimit!==null){
  const count=await one(`SELECT count(*)::int AS used FROM activations WHERE partner_id=:partnerId AND status<>'revoked'`,
   {partnerId},transaction);
  if(Number(count?.used||0)>snapshot.activationLimit)throw new AppError(409,'SERVICE_PACKAGE_ACTIVATIONS_EXCEEDED',
   'A conta já possui mais ativações do que o limite do pacote. Nenhuma ativação será removida.');
 }
}

/** Keep existing monitoring, DNS resolver, PlayerWeb and legacy device APIs intact.
 * Copy finance only; technical defaults inherit the live catalog. */
export async function applyServicePackageToPartner(partnerId, snapshot, transaction, { actorId=null, recordAssignment=true, monthlyFeeCents=null }={}){
 if(!snapshot?.tier || !snapshot?.code)throw new AppError(422,'SERVICE_PACKAGE_INVALID','Pacote de Serviço inválido.');
 await assertPartnerFitsPackage(partnerId,snapshot,transaction);
 await run(`INSERT INTO partner_service_plans(partner_id,tier,max_servers_override,max_apps_override,auto_failover_override,
   auto_priority_override,email_alerts_override,detailed_history_override,activation_limit_inherited)
  VALUES (:partnerId,:tier,NULL,NULL,NULL,NULL,NULL,NULL,true)
  ON CONFLICT(partner_id) DO UPDATE SET tier=excluded.tier,
   max_servers_override=NULL,max_apps_override=NULL,auto_failover_override=NULL,
   auto_priority_override=NULL,email_alerts_override=NULL,detailed_history_override=NULL,
   activation_limit_inherited=true`,{
  partnerId,tier:snapshot.tier},transaction);
 await run(`INSERT INTO content_partner_terms(partner_id,mode,activation_limit,fixed_fee_cents,auto_priority)
   VALUES (:partnerId,:mode,:limit,COALESCE(:fee,0),:priority)
   ON CONFLICT(partner_id) DO UPDATE SET mode=excluded.mode,activation_limit=excluded.activation_limit,
    auto_priority=excluded.auto_priority,
    fixed_fee_cents=COALESCE(:fee,content_partner_terms.fixed_fee_cents)`,{
  partnerId,priority:!!snapshot.autoPriority,fee:monthlyFeeCents,mode:snapshot.activationLimit===null?'fixed_unlimited':'fixed_limited',limit:snapshot.activationLimit},transaction);
 if(recordAssignment){
  await run(`INSERT INTO partner_service_package_assignments(partner_id,package_code,package_snapshot,live_snapshot,assigned_by)
   VALUES (:partnerId,:packageCode,CAST(:snapshot AS jsonb),CAST(:snapshot AS jsonb),:actorId)
   ON CONFLICT(partner_id) DO UPDATE SET package_code=excluded.package_code,
    package_snapshot=excluded.package_snapshot,live_snapshot=excluded.live_snapshot,assigned_by=excluded.assigned_by,assigned_at=now()`,{
   partnerId,packageCode:snapshot.code,snapshot:JSON.stringify(snapshot),actorId},transaction);
 }
 return snapshot;
}

export { packageSnapshotFromRow };
