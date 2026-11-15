import { QueryTypes } from "sequelize";
import { sequelize, Partner } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { move, balancesOf } from "../stock/stock-ledger.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { isPrimaryMaster, maySelfIssue } from "./master-issuance.policy.js";

const query = (sql, replacements, transaction, type=QueryTypes.SELECT) =>
  sequelize.query(sql,{replacements,transaction,type});

async function permissionFor(id, transaction) {
  const rows = await query(`SELECT enabled FROM reseller_master_issuance_permissions WHERE partner_id = :id`,{id},transaction);
  return rows[0]?.enabled === true;
}

/** Consulta segura inclusive para Submaster: sempre retorna enabled=false. */
export async function status(partnerId) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Revenda");
  const primary = isPrimaryMaster(partner);
  const authorized = primary ? await permissionFor(partnerId) : false;
  return { eligible:primary, enabled:maySelfIssue(partner,authorized), authorized, reason:!primary?"A emissão própria é exclusiva de Masters principais.":null };
}

/** Apenas a API administrativa chama esta função, após validação de superadmin. */
export async function configure(partnerId, enabled, actor) {
  return sequelize.transaction(async transaction => {
    const partner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!partner)throw notFound("Revenda");
    if(!isPrimaryMaster(partner)) throw new AppError(403,"ONLY_PRIMARY_MASTER","Apenas Masters principais independentes podem receber permissão de emissão própria.");
    await query(`INSERT INTO reseller_master_issuance_permissions(partner_id,enabled)
       VALUES(:id,:enabled) ON CONFLICT(partner_id)
       DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`,{id:partnerId,enabled},transaction,QueryTypes.RAW);
    await audit({actor,action:enabled?"master.self_issue.enabled":"master.self_issue.disabled",entityType:"partner",entityId:partnerId,metadata:{enabled},transaction});
    return { eligible:true, enabled, authorized:enabled };
  });
}

/** Idempotente: cada chave representa UMA única emissão. Operação e auditoria são atômicas. */
export async function issue(partnerId,{months,quantity,idempotencyKey},actor) {
  return sequelize.transaction(async transaction => {
    // A trava da conta serializa a emissão com vinculação/desvinculação e revogação de autorização.
    const partner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!partner)throw notFound("Revenda");
    if(!isPrimaryMaster(partner)) throw new AppError(403,"ONLY_PRIMARY_MASTER","Submasters e revendas não podem emitir estoque próprio.");
    const allowed=await permissionFor(partnerId,transaction);
    if(!maySelfIssue(partner,allowed))throw new AppError(403,"SELF_ISSUE_NOT_ALLOWED","O Superadmin não autorizou a emissão própria ou a conta está inativa.");
    const previous=(await query(`SELECT months,quantity,balance_after FROM reseller_master_issuance_requests
      WHERE partner_id = :id AND idempotency_key = :key`,{id:partnerId,key:idempotencyKey},transaction))[0];
    if(previous){
      if(Number(previous.months)!==months||Number(previous.quantity)!==quantity)
        throw new AppError(409,"IDEMPOTENCY_CONFLICT","Uma solicitação anterior já utilizou essa identificação com valores diferentes.");
      return {ok:true,alreadyProcessed:true,months,quantity,balanceAfter:Number(previous.balance_after),idempotencyKey};
    }
    await ensurePlan(months,{transaction});
    const balanceAfter=await move(transaction,{partnerId,months,delta:quantity,kind:"grant",actor,
      note:"Emissão própria autorizada pelo Superadmin — Master principal"});
    await query(`INSERT INTO reseller_master_issuance_requests(partner_id,idempotency_key,months,quantity,balance_after)
      VALUES(:id,:key,:months,:quantity,:balance)`,{id:partnerId,key:idempotencyKey,months,quantity,balance:balanceAfter},transaction,QueryTypes.RAW);
    await audit({actor,action:"master.self_issue.granted",entityType:"partner",entityId:partnerId,
      metadata:{months,quantity,balanceAfter,idempotencyKey},transaction});
    return {ok:true,alreadyProcessed:false,months,quantity,balanceAfter,idempotencyKey};
  });
}

export async function requestByKey(partnerId,idempotencyKey) {
  const rows=await query(`SELECT months,quantity,balance_after,created_at FROM reseller_master_issuance_requests
   WHERE partner_id = :id AND idempotency_key = :key`,{id:partnerId,key:idempotencyKey});
  const v=rows[0];return {request:v?{months:Number(v.months),quantity:Number(v.quantity),balanceAfter:Number(v.balance_after),createdAt:v.created_at,idempotencyKey}:null};
}
