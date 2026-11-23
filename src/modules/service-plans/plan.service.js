import { QueryTypes } from "sequelize";
import { sequelize, Partner, PartnerServicePlan, ServicePlanCatalog, ContentPartnerTerms } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { defaultTier, featuresFor, TIERS } from "./plan.rules.js";
import { assertNoSlotDowngrade } from "../client-apps/app-entitlement.js";

const CACHE_MS=20_000, CACHE_MAX=1000, cache=new Map();
export function invalidatePlan(partnerId){if(partnerId)cache.delete(partnerId);else cache.clear();}
function remember(partnerId, result){cache.delete(partnerId);cache.set(partnerId,{at:Date.now(),result});if(cache.size>CACHE_MAX)cache.delete(cache.keys().next().value);return result;}
export async function getServicePlan(partnerId,{fresh=false}={}){
  const hit=cache.get(partnerId);
  if(!fresh && hit && Date.now()-hit.at<CACHE_MS)return hit.result;
  // Uma consulta indexada por chave primária; não são necessários 3 SELECTs.
  // A política final continua sendo decidida exclusivamente por featuresFor().
  const [row] = await sequelize.query(`SELECT p.id, p.kind,
      ps.tier, ps.max_servers_override AS "maxServersOverride",
      ps.max_apps_override AS "maxAppsOverride",
      ps.auto_failover_override AS "autoFailoverOverride",
      ps.auto_priority_override AS "autoPriorityOverride",
      ps.email_alerts_override AS "emailAlertsOverride",
      ps.detailed_history_override AS "detailedHistoryOverride",
      ct.auto_priority AS "contractAutoPriority"
    FROM partners p LEFT JOIN partner_service_plans ps ON ps.partner_id=p.id
    LEFT JOIN content_partner_terms ct ON ct.partner_id=p.id
    WHERE p.id=:partnerId LIMIT 1`, {
      replacements:{partnerId},type:QueryTypes.SELECT,
    });
  if(!row)throw notFound("Parceiro");
  const partner={id:row.id,kind:row.kind};
  const record=row.tier ? {
    tier:row.tier,maxServersOverride:row.maxServersOverride,maxAppsOverride:row.maxAppsOverride,
    autoFailoverOverride:row.autoFailoverOverride,autoPriorityOverride:row.autoPriorityOverride,
    emailAlertsOverride:row.emailAlertsOverride,detailedHistoryOverride:row.detailedHistoryOverride,
  } : null;
  const contract={autoPriority:row.contractAutoPriority};
  const tier=record?.tier||defaultTier(partner.kind);
  const catalog = await ServicePlanCatalog.findByPk(tier,{raw:true});
  if(!catalog)throw new AppError(409,"PLAN_MISSING","Plano técnico não encontrado no catálogo.");
  const features=featuresFor(tier,record||{},catalog);
  features.canResellPanel=Boolean(catalog.canResellPanel);
  features.canCreateSubmasters=Boolean(catalog.canResellPanel&&catalog.canCreateSubmasters);
  features.canViewFinance=Boolean(catalog.canResellPanel&&catalog.canViewFinance);
  features.canManageGateways=Boolean(catalog.canResellPanel&&catalog.canManageGateways);
  // Compatibilidade: o controle antigo de prioridade do contrato continua funcionando.
  if(contract?.autoPriority===false)features.autoPriority=false;
  return remember(partnerId,{tier,planName:catalog.name,features,overrides:{
    maxAppsOverride:record?.maxAppsOverride??null,maxServersOverride:record?.maxServersOverride??null,autoFailoverOverride:record?.autoFailoverOverride??null,
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
    await assertNoSlotDowngrade(partnerId, features.maxApps ?? 0, t);
    // Revenda do painel is a RIGHT OF THE EXISTING PARTNER PLAN, never a new account type.
    // Existing sellers retain their parent link and history; no stock is created.
    const resale={canSell:Boolean(catalog.canResellPanel),
      canCreateSubmasters:Boolean(catalog.canResellPanel&&catalog.canCreateSubmasters),
      canViewFinance:Boolean(catalog.canResellPanel&&catalog.canViewFinance),
      canManageGateways:Boolean(catalog.canResellPanel&&catalog.canManageGateways)};
    // Nunca fazer downgrade silencioso cortando URLs já usadas por clientes.
    if (features.maxServers !== null) {
      const over=await sequelize.query(`SELECT c.id,c.code,count(pool.id)::integer AS count
        FROM partner_codes c JOIN code_server_pools pool ON pool.code_id=c.id
        WHERE c.partner_id=:partnerId AND c.status='active'
        GROUP BY c.id,c.code HAVING count(pool.id) > :maxServers LIMIT 1`,{
        replacements:{partnerId,maxServers:features.maxServers},type:QueryTypes.SELECT,transaction:t});
      if(over.length)throw new AppError(409,"SERVER_POOL_EXCEEDS_PLAN",`O código ${over[0].code} tem ${over[0].count} URLs. Reduza para ${features.maxServers} antes de alterar o plano.`);
    }
    const [row]=await PartnerServicePlan.findOrCreate({where:{partnerId},defaults:{partnerId,tier:defaultTier(partner.kind)},transaction:t});
    await row.update({tier:body.tier,maxAppsOverride:body.maxAppsOverride??null,maxServersOverride:body.maxServersOverride??null,autoFailoverOverride:body.autoFailoverOverride??null,
      autoPriorityOverride:body.autoPriorityOverride??null,emailAlertsOverride:body.emailAlertsOverride??null,
      detailedHistoryOverride:body.detailedHistoryOverride??null},{transaction:t});
    if (['content','both'].includes(partner.kind)) {
      // The existing catalogue's monthly price is what the account pays DeltaTV.
      // Respect pre-existing negotiated contracts (credits/fixed_limited/fixed_unlimited).
      if(catalog.monthlyPriceCents!==null && catalog.monthlyPriceCents!==undefined){
        const terms=await ContentPartnerTerms.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
        if(!terms || terms.mode==='legacy'){
          // Preserve existing device/activation limits when assigning the first
          // paid original plan; never silently turn a limited customer unlimited.
          const existingLimit=terms?.activationLimit??partner.deviceLimit??null;
          const nextMode=existingLimit===null?'fixed_unlimited':'fixed_limited';
          await sequelize.query(`INSERT INTO content_partner_terms(partner_id,mode,fixed_fee_cents,activation_limit)
           VALUES(:partnerId,:mode,:price,:limit)
           ON CONFLICT(partner_id) DO UPDATE SET mode=excluded.mode,
             fixed_fee_cents=excluded.fixed_fee_cents,activation_limit=excluded.activation_limit`,
           {replacements:{partnerId,price:catalog.monthlyPriceCents,mode:nextMode,limit:existingLimit},transaction:t});
          await partner.update({billingModel:'fixed',monthlyFeeCents:catalog.monthlyPriceCents},{transaction:t});
        }
      }
      const existingSeller=await sequelize.query(`SELECT partner_id FROM partner_portal_sellers WHERE partner_id=:partnerId`,
       {replacements:{partnerId},type:QueryTypes.SELECT,transaction:t});
      if(existingSeller.length) {
       await sequelize.query(`UPDATE partner_portal_sellers SET can_sell=:canSell,
         can_create_submasters=:canCreateSubmasters,can_view_finance=:canViewFinance,
         can_manage_gateways=:canManageGateways,updated_at=now() WHERE partner_id=:partnerId`,
         {replacements:{partnerId,...resale},transaction:t});
      } else if(resale.canSell) {
       await sequelize.query(`INSERT INTO partner_portal_sellers
        (partner_id,parent_partner_id,role,can_sell,active,can_create_submasters,can_view_finance,can_manage_gateways)
        VALUES(:partnerId,NULL,'master',true,true,:canCreateSubmasters,:canViewFinance,:canManageGateways)`,
        {replacements:{partnerId,...resale},transaction:t});
      }
    }
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
