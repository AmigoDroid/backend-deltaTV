import { QueryTypes } from "sequelize";
import { sequelize, Partner } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { move } from "../stock/stock-ledger.js";
import { creditBalanceOf } from "../credits/credit-ledger.js";
import { pricesFor } from "../credits/credit.service.js";
import { debitPrepaidIssuance } from "./prepaid-issuance.service.js";
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
  const [creditBalance, prices] = primary
    ? await Promise.all([creditBalanceOf(partnerId), pricesFor(partnerId)])
    : [0, []];
  return { eligible:primary, enabled:maySelfIssue(partner,authorized), authorized,
    requiresPrepaidCredits:true, creditBalance, prices,
    reason:!primary?"A emissão própria é exclusiva de Masters principais.":null };
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
    return { eligible:true, enabled, authorized:enabled, requiresPrepaidCredits:true };
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
    const previous=(await query(`SELECT months,quantity,balance_after,unit_price_credits,total_credits,credit_balance_after FROM reseller_master_issuance_requests
      WHERE partner_id = :id AND idempotency_key = :key`,{id:partnerId,key:idempotencyKey},transaction))[0];
    if(previous){
      if(Number(previous.months)!==months||Number(previous.quantity)!==quantity)
        throw new AppError(409,"IDEMPOTENCY_CONFLICT","Uma solicitação anterior já utilizou essa identificação com valores diferentes.");
      return {ok:true,alreadyProcessed:true,months,quantity,balanceAfter:Number(previous.balance_after),idempotencyKey,
        unitPriceCredits: previous.unit_price_credits == null ? null : Number(previous.unit_price_credits),
        totalCredits: previous.total_credits == null ? null : Number(previous.total_credits),
        creditBalanceAfter: previous.credit_balance_after == null ? null : Number(previous.credit_balance_after) };
    }
    await ensurePlan(months,{transaction});
    // Mesmo com autorização legada, NENHUM Master emite gratuitamente.
    // O débito usa o saldo no banco e ocorre junto da entrada no estoque.
    const charged = await debitPrepaidIssuance(transaction, {
      partnerId, months, quantity, idempotencyKey, actor, channel:"stock",
    });
    const balanceAfter=await move(transaction,{partnerId,months,delta:quantity,kind:"grant",actor,
      note:`Emissão coberta por ${charged.totalCredits} créditos · referência ${idempotencyKey}`});
    await query(`INSERT INTO reseller_master_issuance_requests
      (partner_id,idempotency_key,months,quantity,balance_after,unit_price_credits,total_credits,credit_balance_after)
      VALUES(:id,:key,:months,:quantity,:balance,:unit,:total,:creditBalance)`,
      {id:partnerId,key:idempotencyKey,months,quantity,balance:balanceAfter,
       unit:charged.unitPriceCredits,total:charged.totalCredits,creditBalance:charged.creditBalanceAfter},
      transaction,QueryTypes.RAW);
    await audit({actor,action:"master.self_issue.prepaid",entityType:"partner",entityId:partnerId,
      metadata:{months,quantity,balanceAfter,idempotencyKey,...charged},transaction});
    return {ok:true,alreadyProcessed:false,months,quantity,balanceAfter,idempotencyKey,...charged};
  });
}

export async function requestByKey(partnerId,idempotencyKey) {
  const rows=await query(`SELECT months,quantity,balance_after,unit_price_credits,total_credits,credit_balance_after,created_at FROM reseller_master_issuance_requests
   WHERE partner_id = :id AND idempotency_key = :key`,{id:partnerId,key:idempotencyKey});
  const v=rows[0];return {request:v?{
    months:Number(v.months),quantity:Number(v.quantity),balanceAfter:Number(v.balance_after),
    unitPriceCredits:v.unit_price_credits == null ? null : Number(v.unit_price_credits),
    totalCredits:v.total_credits == null ? null : Number(v.total_credits),
    creditBalanceAfter:v.credit_balance_after == null ? null : Number(v.credit_balance_after),
    createdAt:v.created_at,idempotencyKey,
  }:null};
}
