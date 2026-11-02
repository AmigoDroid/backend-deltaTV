import { Op, QueryTypes } from "sequelize";
import { sequelize, Partner, PartnerCode, Activation, ContentPartnerTerms, ContentCodeBalance, ContentActivationCharge } from "../../db/models/index.js";
import { clearResolutionCache } from "../provider-monitor/resolve.service.js";
import {invalidatePlan} from "../service-plans/plan.service.js";
import { clearContractAccessCache } from "../access/access.service.js";
import { creditMove, creditBalanceOf } from "../credits/credit-ledger.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import {shouldCharge,remainingLicenses} from "./contract.rules.js";
import { pageOf, paged } from "../../shared/pagination.js";

export const DEFAULT_TERMS={mode:"legacy",fixedFeeCents:0,activationLimit:null,licensePolicy:"standard",creditsPerActivation:1,autoPriority:true};
const contentKind=(p)=>p && ["content","both"].includes(p.kind);
const termsOf=(row)=>row?row.toJSON():{...DEFAULT_TERMS};
const allowedMode=new Set(["legacy","credits","fixed_unlimited","fixed_limited"]);

export async function termsFor(partnerId,transaction) {
  return termsOf(await ContentPartnerTerms.findByPk(partnerId,{transaction}));
}
export async function dashboard(partnerId) {
  const partner=await Partner.findByPk(partnerId,{attributes:["id","kind","name","status","billingModel"]});
  if(!contentKind(partner))throw notFound("Parceiro de conteúdo");
  const [terms,creditBalance,activeDevices,totalCodes,spent]=await Promise.all([
    termsFor(partnerId),creditBalanceOf(partnerId),
    Activation.count({where:{partnerId,status:{[Op.ne]:"revoked"}}}),
    PartnerCode.count({where:{partnerId,status:"active"}}),
    sequelize.query(`SELECT COALESCE(sum(b.allocated),0) AS allocated, COALESCE(sum(b.spent),0) AS spent
      FROM content_code_balances b JOIN partner_codes c ON c.id=b.code_id WHERE c.partner_id=:partnerId`,
      {replacements:{partnerId},type:QueryTypes.SELECT}),
  ]);
  const allocated=Number(spent[0]?.allocated||0),used=Number(spent[0]?.spent||0);
  return {partner:{name:partner.name,status:partner.status},terms,creditBalance,allocatedCredits:allocated,spentCredits:used,
    availableCodeCredits:allocated-used,activeDevices,totalCodes,
    remainingActivations:remainingLicenses({mode:terms.mode,activationLimit:terms.activationLimit,activeDevices,
      availableCredits:allocated-used,creditsPerActivation:Math.max(1,terms.creditsPerActivation)})};
}

export async function saveTerms(partnerId,input,actor) {
  if(!allowedMode.has(input.mode))throw new AppError(422,"INVALID_MODE","Modalidade inválida.");
  if(input.mode==="fixed_limited" && input.activationLimit===null)throw new AppError(422,"ACTIVATION_LIMIT_REQUIRED","Informe o limite de ativações.");
  const result=await sequelize.transaction(async t=>{
    const partner=await Partner.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(!contentKind(partner))throw notFound("Parceiro de conteúdo");
    // ON CONFLICT garante 1 linha por parceiro e evita corrida na primeira edição.
    await sequelize.query(`INSERT INTO content_partner_terms(partner_id) VALUES (:partnerId) ON CONFLICT DO NOTHING`,{replacements:{partnerId},transaction:t});
    const row=await ContentPartnerTerms.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
    const before=termsOf(row);
    await row.update(input,{transaction:t});
    // Mesma mensalidade do mecanismo de faturas já existente, sem segundo sistema de cobrança.
    if(input.mode.startsWith("fixed_")) await partner.update({billingModel:"fixed",monthlyFeeCents:input.fixedFeeCents},{transaction:t});
    if(input.mode==="credits") await partner.update({billingModel:"none"},{transaction:t});
    await audit({actor,action:"content.terms.update",entityType:"partner",entityId:partnerId,metadata:{before,after:termsOf(row)},transaction:t});
    return termsOf(row);
  });
  invalidatePlan(partnerId);
  clearResolutionCache();
  clearContractAccessCache();
  return result;
}

export async function adminAdjust(partnerId,{delta,note},actor) {
  const partner=await Partner.findByPk(partnerId,{attributes:["id","kind"]});
  if(!contentKind(partner))throw notFound("Parceiro de conteúdo");
  return sequelize.transaction(async t=>{
    const balance=await creditMove(t,{partnerId,delta,kind:"adjust",note,actor});
    await audit({actor,action:"content.credits.adjust",entityType:"partner",entityId:partnerId,metadata:{delta,balance,note},transaction:t});
    return {balance};
  });
}

/** Saldo fica no banco de créditos já existente. Cada código recebe um envelope com saldo independente. */
export async function allocate(partnerId,codeId,{quantity},actor) {
  return sequelize.transaction(async t=>{
    const partner=await Partner.findByPk(partnerId,{attributes:["id","kind"],transaction:t});
    if(!contentKind(partner))throw notFound("Parceiro de conteúdo");
    // Serializa alocações/consumos do mesmo parceiro em uma única linha pequena.
    await sequelize.query(`INSERT INTO content_partner_terms(partner_id) VALUES (:partnerId) ON CONFLICT DO NOTHING`,{replacements:{partnerId},transaction:t});
    const terms=await ContentPartnerTerms.findByPk(partnerId,{transaction:t,lock:t.LOCK.UPDATE});
    if(quantity>0 && terms.mode!=="credits")throw new AppError(409,"NOT_CREDIT_PLAN","Novas alocações exigem a modalidade de créditos. A devolução de saldo livre continua permitida.");
    const code=await PartnerCode.findOne({where:{id:codeId,partnerId},transaction:t});
    if(!code)throw notFound("Código");
    if(quantity>0&&code.status!=="active")throw new AppError(409,"CODE_INACTIVE","Somente códigos ativos podem receber créditos. Créditos não usados podem ser devolvidos.");
    if(code.licenseMonths)throw new AppError(409,"STOCK_CODE","Código de estoque não pode receber cobrança dupla.");
    if(quantity>0)await creditMove(t,{partnerId,delta:-quantity,kind:"purchase",note:`Reserva para código ${code.code}`,quantity,unitPriceCredits:1,actor});
    await sequelize.query(`INSERT INTO content_code_balances(code_id) VALUES (:codeId) ON CONFLICT DO NOTHING`,{replacements:{codeId},transaction:t});
    const balance=await ContentCodeBalance.findByPk(codeId,{transaction:t,lock:t.LOCK.UPDATE});
    if(quantity<0 && balance.allocated-balance.spent < -quantity)throw new AppError(409,"CREDITS_IN_USE","Só é possível devolver créditos ainda não utilizados.");
    await balance.update({allocated:balance.allocated+quantity},{transaction:t});
    if(quantity<0)await creditMove(t,{partnerId,delta:-quantity,kind:"adjust",note:`Devolução de reserva do código ${code.code}`,actor});
    await audit({actor,action:"content.code.credit_allocation",entityType:"partner_code",entityId:codeId,metadata:{quantity,allocated:balance.allocated,spent:balance.spent},transaction:t});
    return {codeId,allocated:balance.allocated,spent:balance.spent,available:balance.allocated-balance.spent};
  });
}

export async function balancesForCodes(codeIds) {
  if(!codeIds.length)return new Map();
  const rows=await ContentCodeBalance.findAll({where:{codeId:{[Op.in]:codeIds}},raw:true});
  return new Map(rows.map(x=>[x.codeId,{allocated:x.allocated,spent:x.spent,available:x.allocated-x.spent}]));
}

/** Invocada dentro da mesma transação que cria/atualiza a ativação. Não há débito no login repetido da mesma lista. */
export async function authorizeActivation(t,{partner,code,activation,isNew,previousCodeId}) {
  const terms=await ContentPartnerTerms.findByPk(partner.id,{transaction:t,lock:t.LOCK.UPDATE});
  const mode=terms?.mode||"legacy";
  if(mode==="legacy")return;
  if(mode==="fixed_limited" && isNew){
    const used=await Activation.count({where:{partnerId:partner.id,status:{[Op.ne]:"revoked"}},transaction:t});
    if(used>terms.activationLimit)throw new AppError(409,"PARTNER_CONTRACT_LIMIT","Limite contratado de ativações atingido.");
  }
  if(mode!=="credits"||!shouldCharge({isNew,previousCodeId,codeId:code.id}))return;
  if(code.licenseMonths)throw new AppError(409,"DOUBLE_CHARGE","Código com estoque não pode ser cobrado também por créditos de conteúdo.");
  const prior=await ContentActivationCharge.findOne({where:{activationId:activation.id,codeId:code.id},transaction:t});
  if(prior)return;
  const account=await ContentCodeBalance.findByPk(code.id,{transaction:t,lock:t.LOCK.UPDATE});
  const cost=terms.creditsPerActivation;
  if(!account||account.allocated-account.spent<cost)throw new AppError(409,"CODE_NO_CREDITS","Créditos insuficientes para ativar este código.");
  await account.update({spent:account.spent+cost},{transaction:t});
  await ContentActivationCharge.create({activationId:activation.id,codeId:code.id,credits:cost},{transaction:t});
  await audit({actor:{type:"system",id:"activation"},action:"content.credits.consume",entityType:"activation",entityId:activation.id,metadata:{codeId:code.id,credits:cost},transaction:t});
}

export async function listDevices(partnerId,{codeId,q,page,pageSize}) {
  if(codeId && !await PartnerCode.count({where:{id:codeId,partnerId}}))throw notFound("Código");
  const where={partnerId,...(codeId?{partnerCodeId:codeId}:{}),
    ...(q?{mac:{[Op.iLike]:`%${q.replace(/[\\%_]/g,"\\$&")}%`}}:{})};
  const {rows,count}=await Activation.findAndCountAll({where,attributes:["id","mac","status","activatedAt","revokedAt","partnerCodeId","providerId","grantedLicenseId"],
    include:[{model:PartnerCode,attributes:["code","label"]}],order:[["activatedAt","DESC"],["id","DESC"]],...pageOf({page,pageSize})});
  return paged(rows.map(a=>({id:a.id,mac:a.mac,status:a.status,activatedAt:a.activatedAt,revokedAt:a.revokedAt,
    code:a.PartnerCode?.code||null,label:a.PartnerCode?.label||null,providerId:a.providerId,
    licenseSource:a.grantedLicenseId?"reseller_stock":"partner"})),count,{page,pageSize});
}
