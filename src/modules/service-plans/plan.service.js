import { QueryTypes } from "sequelize";
import { sequelize, Partner, PartnerServicePlan, ServicePlanCatalog, ContentPartnerTerms } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { defaultTier, featuresFor, TIERS } from "./plan.rules.js";

const CACHE_MS=20_000, CACHE_MAX=1000, cache=new Map();
export function invalidatePlan(partnerId){if(partnerId)cache.delete(partnerId);else cache.clear();}
function remember(partnerId, result){cache.delete(partnerId);cache.set(partnerId,{at:Date.now(),result});if(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);return result;}
export async function getServicePlan(partnerId,{fresh=false}={}){
  const hit=cache.get(partnerId);
  if(!fresh && hit && Date.now()-hit.at<CACHE_MS)return hit.result;
  const [partner,record,contract]=await Promise.all([
    Partner.findByPk(partnerId,{attributes:["id","kind"],raw:true}),
    PartnerServicePlan.findByPk(partnerId,{raw:true}),
    ContentPartnerTerms.findByPk(partnerId,{attributes:["autoPriority"],raw:true}),
  ]);
  if(!partner)throw notFound("Parceiro");
  const tier=record?.tier||defaultTier(partner.kind);
  const catalog = await ServicePlanCatalog.findByPk(tier,{raw:true});
  if(!catalog)throw new AppError(409,"PLAN_MISSING","Plano técnico não encontrado no catálogo.");
  const features=featuresFor(tier,record||{},catalog);
  // Compatibilidade: o controle antigo de prioridade do contrato continua funcionando.
  if(contract?.autoPriority===false)features.autoPriority=false;
  return remember(partnerId,{tier,planName:catalog.name,features,overrides:{
    maxServersOverride:record?.maxServersOverride??null,autoFailoverOverride:record?.autoFailoverOverride??null,
    autoPriorityOverride:record?.autoPriorityOverride??null,emailAlertsOverride:record?.emailAlertsOverride??null,
    detailedHistoryOverride:record?.detailedHistoryOverride??null,
  },tiers:TIERS});
}
export async function updateServicePlan(partnerId,body,actor){
  if(actor?.role!=="superadmin")throw new AppError(403,"SUPERADMIN_REQUIRED","Apenas o superadmin pode negociar estes recursos.");
  await sequelize.transaction(async t=>{
    const partner=await Partner.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(!partner)throw notFound("Parceiro");
    const catalog=await ServicePlanCatalog.findByPk(body.tier,{transaction:t,lock:t.LOCK.UPDATE});
    if(!catalog||!catalog.active)throw new AppError(409,"PLAN_UNAVAILABLE","Plano indisponível para novas atribuições.");
    if(catalog.audience!=="both" && partner.kind!=="both" && catalog.audience!==partner.kind)
      throw new AppError(422,"PLAN_AUDIENCE","Este plano não é permitido para esse tipo de parceiro.");
    const features=featuresFor(body.tier,body,catalog);
    // Nunca fazer downgrade silencioso cortando URLs já usadas por clientes.
    const over=await sequelize.query(`SELECT c.id,c.code,count(pool.id)::integer AS count
      FROM partner_codes c JOIN code_server_pools pool ON pool.code_id=c.id
      WHERE c.partner_id=:partnerId AND c.status='active'
      GROUP BY c.id,c.code HAVING count(pool.id)>:maxServers LIMIT 1`,{
      replacements:{partnerId,maxServers:features.maxServers},type:QueryTypes.SELECT,transaction:t});
    if(over.length)throw new AppError(409,"SERVER_POOL_EXCEEDS_PLAN",`O código ${over[0].code} tem ${over[0].count} URLs. Reduza para ${features.maxServers} antes de alterar o plano.`);
    const [row]=await PartnerServicePlan.findOrCreate({where:{partnerId},defaults:{partnerId,tier:defaultTier(partner.kind)},transaction:t});
    await row.update({tier:body.tier,maxServersOverride:body.maxServersOverride??null,autoFailoverOverride:body.autoFailoverOverride??null,
      autoPriorityOverride:body.autoPriorityOverride??null,emailAlertsOverride:body.emailAlertsOverride??null,
      detailedHistoryOverride:body.detailedHistoryOverride??null},{transaction:t});
    await audit({actor,action:"partner.service_plan.updated",entityType:"partner",entityId:partnerId,
      metadata:{tier:body.tier,features,overrides:body},transaction:t});
  });
  invalidatePlan(partnerId);
  // Quando o plano muda, caches antigos de pools e sessões não podem manter opções revogadas.
  const [{invalidateServerPools},{clearResolutionCache}]=await Promise.all([
    import("../provider-monitor/code-pool.service.js"),import("../provider-monitor/resolve.service.js")]);
  invalidateServerPools();clearResolutionCache();
  return getServicePlan(partnerId,{fresh:true});
}
