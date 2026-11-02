import { Op } from "sequelize";
import { sequelize, PartnerCode, PartnerProvider, CodeServerPool, ProviderHealth } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import {getServicePlan} from "../service-plans/plan.service.js";

const TTL = 30_000;
const MAX_CACHE = 1500;
const poolCache = new Map();
export function invalidateServerPools(codeId) {
  if (codeId) poolCache.delete(codeId); else poolCache.clear();
  clearMirrorAuth();
}
function save(key, rows) {
  poolCache.delete(key);
  poolCache.set(key, {at: Date.now(), rows});
  if (poolCache.size > MAX_CACHE) poolCache.delete(poolCache.keys().next().value);
}
/** Retorna exclusivamente servidores autorizados para ESTE código. Sem associações = somente servidor original. */
export async function serversForCode(code, { bypassCache = false } = {}) {
  const hit = poolCache.get(code.id);
  if (!bypassCache && hit && Date.now() - hit.at < TTL) return hit.rows;
  const plan=await getServicePlan(code.partnerId);
  const links = await CodeServerPool.findAll({where:{codeId: code.id}, attributes:["providerId"], raw:true});
  const ids = links.length ? links.map(x => x.providerId) : (code.providerId ? [code.providerId] : []);
  if (!ids.length) {
    // Compatibilidade com códigos antigos sem provider_id: esses códigos já aceitavam qualquer servidor
    // ativo da própria parceria. Não alterar esse comportamento silenciosamente.
    const legacy=await PartnerProvider.findAll({where:{partnerId:code.partnerId,status:"active"},order:[["priority","ASC"],["createdAt","ASC"]],raw:true});
    const allowed=plan.features.autoFailover ? legacy.slice(0,plan.features.maxServers) : legacy.slice(0,1);
    save(code.id,allowed);return allowed;
  }
  const rows = await PartnerProvider.findAll({where:{id:{[Op.in]:ids},partnerId:code.partnerId,status:"active"},raw:true});
  const allowed=plan.features.autoFailover ? rows.slice(0,plan.features.maxServers) : rows.filter(s=>s.id===code.providerId).slice(0,1);
  save(code.id,allowed);
  return allowed;
}
/** Atualização atômica; 1–8 servidores ativos e da mesma parceria, sem duplicidades. */
export async function setCodeServers(partnerId, codeId, ids, actor) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length) {
    throw new AppError(422,"INVALID_SERVER_POOL","Escolha entre 1 e 8 servidores diferentes.");
  }
  const result = await sequelize.transaction(async (t) => {
    // Mesmo lock que updateServicePlan: downgrade e seleção de pool não competem entre si.
    const parent=await sequelize.models.Partner.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(!parent)throw notFound("Parceiro");
    const plan=await getServicePlan(partnerId,{fresh:true});
    if(ids.length>plan.features.maxServers)throw new AppError(403,"PLAN_SERVER_LIMIT",`Seu plano permite até ${plan.features.maxServers} URL(s) por código.`);
    if(ids.length>1 && !plan.features.autoFailover)throw new AppError(403,"PLAN_FAILOVER_DISABLED","O seu plano não permite failover automático.");
    const code = await PartnerCode.findOne({where:{id:codeId,partnerId},transaction:t,lock:t.LOCK.UPDATE});
    if (!code) throw notFound("Código");
    if (code.status !== "active") throw new AppError(409,"CODE_INACTIVE","Código inativo.");
    const servers = await PartnerProvider.findAll({where:{id:{[Op.in]:ids},partnerId,status:"active"},transaction:t});
    if (servers.length !== ids.length) throw new AppError(422,"INVALID_SERVER_POOL","Os servidores devem estar ativos e pertencer à sua parceria.");
    // Não alterar o provedor da ativação; ele permanece como origem segura para rollback.
    await CodeServerPool.destroy({where:{codeId},transaction:t});
    await CodeServerPool.bulkCreate(ids.map(providerId=>({codeId,providerId})),{transaction:t});
    await code.update({providerId:ids[0]},{transaction:t});
    await audit({actor,action:"partner.code.server_pool",entityType:"partner_code",entityId:codeId,
      metadata:{serverIds:ids},transaction:t});
    return {codeId,providerId:ids[0],serverIds:ids};
  });
  invalidateServerPools(codeId);
  return result;
}
/** Dados mínimos para o portal, limitados por página de códigos (não envia todas as linhas da tabela). */
export async function listCodeServerIds(codeIds) {
  if (!codeIds.length) return new Map();
  const rows=await CodeServerPool.findAll({where:{codeId:{[Op.in]:codeIds}},attributes:["codeId","providerId"],raw:true});
  const map=new Map();
  for(const r of rows){if(!map.has(r.codeId))map.set(r.codeId,[]);map.get(r.codeId).push(r.providerId);}
  return map;
}
export async function rankedServersForCode(code) {
  const servers=await serversForCode(code);
  if (!servers.length) return [];
  const states=await ProviderHealth.findAll({where:{providerId:{[Op.in]:servers.map(s=>s.id)}},raw:true});
  const byId=new Map(states.map(h=>[h.providerId,h]));
  const plan=await getServicePlan(code.partnerId);
  const auto=plan.features.autoPriority;
  const active=servers.map(s=>({...s,health:byId.get(s.id)}));
  // Prioridade efetiva dinâmica, computada em memória; nunca grava no banco a cada sondagem.
  // Saúde tem precedência. Dentro do mesmo estado, escolha entre preferência manual ou menor latência.
  return active.sort((a,b)=>{
    const rank=s=>s.health?.state==="healthy"?0:s.health?.state==="down"?2:1;
    return rank(a)-rank(b) || (auto ? (a.health?.latencyMs??1e9)-(b.health?.latencyMs??1e9) || a.priority-b.priority
      : a.priority-b.priority || (a.health?.latencyMs??1e9)-(b.health?.latencyMs??1e9));
  });
}

/** Verifica pertencimento sob a MESMA transação da ativação (impede associação cruzada ou alterada). */
export async function isCodeServerAllowed(code, providerId, transaction) {
  const linked = await CodeServerPool.count({where:{codeId:code.id},transaction});
  if(!linked){
    if(code.providerId)return code.providerId===providerId;
    return !!(await PartnerProvider.count({where:{id:providerId,partnerId:code.partnerId,status:"active"},transaction}));
  }
  return !!(await CodeServerPool.count({where:{codeId:code.id,providerId},transaction}));
}
