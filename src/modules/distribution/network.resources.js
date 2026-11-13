import { QueryTypes } from "sequelize";
import { sequelize, Partner } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { lineageOf, requireMaster } from "./network.service.js";

export const NETWORK_RESOURCES = Object.freeze(["servers","codes","devices","clients","stock","credits","web","white_label","remote"]);
const rowsFor = (ids, transaction) => sequelize.query(`SELECT partner_id,resource,enabled,limit_value FROM reseller_network_resources WHERE partner_id IN (:ids)`,{
  replacements:{ids},transaction,type:QueryTypes.SELECT,
});
export async function effectiveResources(partnerId, transaction) {
  const chain = await lineageOf(partnerId, transaction);
  const all = await rowsFor(chain.map(p=>p.id),transaction);
  const resources = Object.fromEntries(NETWORK_RESOURCES.map(key => [key,{enabled:true,limit:null}]));
  // An invalid/suspended ancestor must not leave descendant content routes operational.
  const chainActive=chain.every(p=>p.status==="active"&&
    (!p.ends_at||new Date(p.ends_at).getTime()>Date.now())&&
    (p.hops===0||p.distribution_role==="master"));
  if(!chainActive) for(const resource of Object.values(resources))resource.enabled=false;
  // Ancestor rules must never be overridden by a descendant.
  for(const record of all){
    const current=resources[record.resource]; if(!current) continue;
    current.enabled = current.enabled && record.enabled;
    if(record.limit_value!==null) current.limit = Math.min(current.limit ?? Infinity, Number(record.limit_value));
  }
  return resources;
}
export async function directResources(partnerId) {
  const rows = await rowsFor([partnerId]);
  return Object.fromEntries(NETWORK_RESOURCES.map(r=>{
    const item=rows.find(x=>x.resource===r);
    return [r,{enabled:item?.enabled ?? true,limit:item?.limit_value ?? null}];
  }));
}
export async function setResource({targetId,actorParentId=null,resource,enabled,limit},actor) {
  if(!NETWORK_RESOURCES.includes(resource)) throw new AppError(422,"INVALID_RESOURCE","Recurso não reconhecido.");
  if(resource!=="servers" && limit!==null) throw new AppError(422,"INVALID_LIMIT","Limite numérico disponível apenas para servidores.");
  return sequelize.transaction(async transaction=>{
    // All hierarchy and permission mutations share the same transaction-level lock.
    await sequelize.query("SELECT pg_advisory_xact_lock(99111701)",{transaction});
    const ids=[targetId,...(actorParentId?[actorParentId]:[])].sort();
    const locked=await Partner.findAll({where:{id:ids},transaction,lock:transaction.LOCK.UPDATE});
    const target=locked.find(p=>p.id===targetId);
    if(!target) throw notFound("Revenda");
    if(actorParentId){
      await requireMaster(actorParentId,"canInvite",transaction);
      if(target.parentPartnerId!==actorParentId) throw notFound("Revenda dessa rede");
      const own=(await effectiveResources(actorParentId,transaction))[resource];
      if(enabled&&!own.enabled) throw new AppError(403,"CAPABILITY_ESCALATION","Você não pode oferecer um recurso que não possui.");
      if(limit!=null&&own.limit!=null&&limit>own.limit) throw new AppError(403,"CAPABILITY_ESCALATION","O limite não pode ser maior que o seu.");
    }
    await sequelize.query(`INSERT INTO reseller_network_resources(partner_id,resource,enabled,limit_value)
      VALUES(:id,:resource,:enabled,:limit) ON CONFLICT(partner_id,resource)
      DO UPDATE SET enabled=EXCLUDED.enabled,limit_value=EXCLUDED.limit_value,updated_at=now()`,{
        replacements:{id:targetId,resource,enabled,limit},transaction,type:QueryTypes.RAW,
    });
    await audit({actor,action:"distribution.resource.updated",entityType:"partner",entityId:targetId,metadata:{resource,enabled,limit,actorParentId},transaction});
    return {resource,enabled,limit};
  });
}

const matchResource=(path)=>{
  if(/^\/(?:providers|servers)(?:\/|$)/.test(path)) return "servers";
  if(/^\/codes(?:\/|$)/.test(path)) return "codes";
  if(/^\/devices\/[^/]+\/remote(?:\/|$)/.test(path)) return "remote";
  if(/^\/devices(?:\/|$)/.test(path)||/^\/mac(?:\/|$)/.test(path)) return "devices";
  if(/^\/clients(?:\/|$)/.test(path)) return "clients";
  if(/^\/stock(?:\/|$)/.test(path)||/^\/licenses(?:\/|$)/.test(path)) return "stock";
  if(/^\/credits(?:\/|$)/.test(path)||/^\/pix(?:\/|$)/.test(path)) return "credits";
  if(/^\/web-access(?:\/|$)/.test(path)) return "web";
  if(/^\/white-label(?:\/|$)/.test(path)) return "white_label";
  return null;
};
export async function networkResourceGuard(req,_res,next){
  const key=matchResource(req.path);
  if(!key) return next();
  const effective=await effectiveResources(req.user.partnerId);
  if(!effective[key].enabled) throw new AppError(403,"NETWORK_RESOURCE_DISABLED","Este recurso não está habilitado para sua revenda. Converse com seu Master.");
  next();
}
