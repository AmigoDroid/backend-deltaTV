import { Op, QueryTypes } from "sequelize";
import { sequelize, PartnerServicePlan, ServicePlanCatalog } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { invalidatePlan } from "./plan.service.js";

async function clearCaches(){
  invalidatePlan();
  const [{ invalidateServerPools }, { clearResolutionCache }] = await Promise.all([
    import("../provider-monitor/code-pool.service.js"), import("../provider-monitor/resolve.service.js")]);
  invalidateServerPools(); clearResolutionCache();
}

export async function listCatalog({ includeInactive = true } = {}) {
  const where = includeInactive ? {} : { active: true };
  const rows = await ServicePlanCatalog.findAll({ where, order: [["sortOrder", "ASC"], ["name", "ASC"]], raw: true });
  const counts = await PartnerServicePlan.findAll({
    attributes: ["tier", [sequelize.fn("COUNT", sequelize.col("partner_id")), "assignedCount"]],
    group: ["tier"], raw: true,
  });
  const byTier = new Map(counts.map(row => [row.tier, Number(row.assignedCount)]));
  return rows.map(r => ({ ...r, assignedCount: byTier.get(r.key) || 0 }));
}

async function validatePlanChanges(key, body, transaction) {
  const badAudience = await sequelize.query(`SELECT p.name
    FROM partners p LEFT JOIN partner_service_plans s ON s.partner_id=p.id
    WHERE coalesce(s.tier, CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=:key
      AND p.status <> 'deleted'
      AND p.kind <> 'both' AND :audience <> 'both' AND p.kind <> :audience
    LIMIT 1`, {
    replacements: { key, audience:body.audience }, type: QueryTypes.SELECT, transaction,
  });
  if (badAudience.length) throw new AppError(409,"PLAN_AUDIENCE_IN_USE",`O plano já é usado por ${badAudience[0].name}, com outro tipo de cadastro.`);
  const tooMany = await sequelize.query(`SELECT c.code, count(pool.id)::integer AS total
    FROM partners p
    LEFT JOIN partner_service_plans s ON s.partner_id=p.id
    JOIN partner_codes c ON c.partner_id=p.id AND c.status='active'
    JOIN code_server_pools pool ON pool.code_id=c.id
    WHERE coalesce(s.tier, CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=:key
      AND (s.max_servers_override > 0 OR (s.max_servers_override IS NULL AND :limit IS NOT NULL))
    GROUP BY c.code,c.id,s.max_servers_override
    HAVING count(pool.id)>coalesce(nullif(s.max_servers_override,0),:limit)
    LIMIT 1`, { replacements:{key,limit:body.maxServers}, type:QueryTypes.SELECT, transaction });
  if (tooMany.length) throw new AppError(409,"SERVER_POOL_EXCEEDS_PLAN",`O código ${tooMany[0].code} possui mais URLs que o novo limite. Ajuste antes de salvar.`);
}

export async function createCatalogPlan(input, actor) {
  let record;
  await sequelize.transaction(async t => {
    record = await ServicePlanCatalog.create({ ...input, active: true, system: false }, { transaction:t });
    await audit({ actor, action:"service_plan.created", entityType:"service_plan", entityId:record.key,
      metadata:{name:record.name,audience:record.audience}, transaction:t });
  });
  await clearCaches(); return record.toJSON();
}
export async function updateCatalogPlan(key, input, actor) {
  let record;
  await sequelize.transaction(async t => {
    record = await ServicePlanCatalog.findByPk(key, { transaction:t, lock:t.LOCK.UPDATE });
    if (!record) throw notFound("Plano");
    if (record.system && input.active === false) throw new AppError(409,"DEFAULT_PLAN_REQUIRED","Planos padrão não podem ser desativados. Duplique-os se precisar de alternativas.");
    await validatePlanChanges(key, input, t);
    const before = record.toJSON();
    await record.update(input, {transaction:t});
    await audit({ actor, action:"service_plan.updated", entityType:"service_plan", entityId:key,
      metadata:{before,after:record.toJSON()}, transaction:t });
  });
  await clearCaches(); return record.toJSON();
}
export async function removeCatalogPlan(key, actor) {
  await sequelize.transaction(async t => {
    const record = await ServicePlanCatalog.findByPk(key, { transaction:t, lock:t.LOCK.UPDATE });
    if (!record) throw notFound("Plano");
    if (record.system) throw new AppError(409,"DEFAULT_PLAN_REQUIRED","Os planos padrão não podem ser excluídos.");
    const used = await PartnerServicePlan.count({ where:{tier:key},transaction:t });
    if (used) throw new AppError(409,"PLAN_IN_USE",`Este plano está atribuído a ${used} cadastro(s). Reatribua-os antes de excluir; você também pode desativar o plano para impedir novas atribuições.`);
    await record.destroy({transaction:t});
    await audit({ actor, action:"service_plan.deleted", entityType:"service_plan", entityId:key,
      metadata:{name:record.name}, transaction:t });
  });
  await clearCaches(); return { ok:true };
}
