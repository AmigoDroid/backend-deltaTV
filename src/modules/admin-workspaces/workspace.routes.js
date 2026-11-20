import { deleteScopedActivation, bulkScopedActivation } from "../admin-deletion.service.js";
import { Router } from "express";
import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import { randomBytes } from "node:crypto";
import { sequelize, AdminUser, Partner, PartnerServicePlan, ContentPartnerTerms,
  ServicePlanCatalog, AdminNetworkInvitation, Activation, Invoice, PartnerCode, PartnerProvider } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import * as codesService from "../partners/partner.service.js";
import * as providerService from "../providers/provider.service.js";
import { DEFAULT_TEMPLATE } from "../providers/playlist-url.js";
import {listActivations,changeActivation,getActivation,listDevices,deviceHistory,deviceAttribution} from "../devices/device.service.js";
import {registeredDeviceById,configureDeviceByAdmin} from "../devices/registration.service.js";
import {registerDeviceFromPanel} from "../devices/unlinked.service.js";
import {ownedDevice,ownedActivation,scopedCode,deviceDeletionPreviewScoped,scopedDeviceAction,bulkScopedDevices} from "../devices/scoped-device.service.js";
import {generateInvoice} from "../billing/billing.service.js";
import { AppError } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { invalidatePlan } from "../service-plans/plan.service.js";
import {invalidateServerPools} from "../provider-monitor/code-pool.service.js";
import {clearResolutionCache} from "../provider-monitor/resolve.service.js";
import { clearContractAccessCache } from "../access/access.service.js";
import { adminHasNetworkPermission, enforceLimit } from "./permissions.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { partnerStatusWhere } from "../partners/partner-status.query.js";
import { isHiddenNetworkPlan } from "../service-plans/network-plan-visibility.js";
import { SIGNUP_PENDING_REASON } from "../partners/reseller-signup.service.js";
import {scopedPlan,checkPlanCaps,provisionNetworkAccount,lockNetworkOwner} from "./account-provisioning.js";
import networkInviteAdminRoutes from "./network-invite-admin.routes.js";
import { workspaceFinance } from "../network-finance/finance.routes.js";
import {confirmPendingContractFromWorkspace} from "../network-finance/finance.service.js";
import {partnerDeletionPreview,deletePartnerAsSuper} from "../admin-deletion.service.js";
import {listPartnerTrash,restorePartnerFromTrash} from "../partner-trash.service.js";
import {codeDeletionPreview,deleteCodeOperational,providerDeletionPreview,deleteProviderOperational} from "../providers/operational-deletion.service.js";

// API isolada para redes comerciais de Admins. Sem acesso às consultas globais
// do painel DeltaTV. O ID do titular é derivado da sessão, não de filtros livres.
const router = Router();
router.use(async (req, res, next) => {
  res.set("Cache-Control", "private, no-store");
  if (req.user?.role !== "admin" && req.user?.role !== "superadmin")
    throw new AppError(403,"ADMIN_WORKSPACE_ONLY","Área reservada à administração.");
  if (req.user.role === "superadmin") {
    if (req.path === "/admins" && req.method === "GET") return next();
    const target = req.query.adminId;
    // DeltaTV pode operar diretamente sua rede principal (owner_admin_id IS NULL).
    if(target==='deltatv'){req.networkOwnerId=null;return next();}
    if (typeof target !== "string" || !z.string().uuid().safeParse(target).success)
      throw new AppError(422,"ADMIN_TARGET_REQUIRED","Selecione qual rede administrativa deseja gerenciar.");
    const user = await AdminUser.findOne({where:{id:target,role:"admin",deletedAt:null},attributes:["id"]});
    if(!user)throw new AppError(404,"NOT_FOUND","Admin não encontrado.");
    req.networkOwnerId=target;
  } else {
    req.networkOwnerId=req.user.id; // nunca aceitar adminId enviado por outro Admin
  }
  next();
});
const requireScope = permission => (req, _res, next) => {
  if (!adminHasNetworkPermission(req.user, permission))
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","A DeltaTV não autorizou esta função para sua conta.");
  next();
};
const tenant = req => req.networkOwnerId;
// Convites usam o mesmo escopo de sessão e as mesmas permissões do cadastro direto.
router.use('/invitations',networkInviteAdminRoutes);
router.use('/finance',workspaceFinance);
const ident = z.object({ id: z.string().uuid() });
const listQuery = z.object({ page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20), q: z.string().trim().max(100).optional(),
  kind: z.enum(["content","reseller","both"]).optional(),
  status: z.enum(["pending","active","expired","suspended","blocked","cancelled"]).optional() });
const intLimit = z.number().int().min(0).max(2147483647).nullable();
const packageFields = z.object({
  name: z.string().trim().min(3).max(120), description: z.string().trim().max(500).default(""),
  audience: z.enum(["content","reseller","both"]), monthlyPriceCents: z.number().int().min(0).max(100000000),
  maxServers: intLimit, activationLimit: intLimit, validityDays: z.number().int().min(1).max(3660),
  autoFailover: z.boolean(), autoPriority: z.boolean(),
  emailAlerts: z.boolean(), detailedHistory: z.boolean(),
  hiddenFromNetwork:z.boolean().default(false),
}).strict();
const packageBody = packageFields.refine(v=>v.autoFailover || !v.autoPriority,{path:["autoPriority"],message:"Prioridade exige failover."});
const account = z.object({name:z.string().trim().min(2).max(160), email:z.string().trim().email().max(200), password:z.string().min(12).max(128)}).strict();
// A conta é cadastrada com apenas nome, e-mail, senha e plano.
// Mensalidade, DNS, ativações e validade vêm EXCLUSIVAMENTE do plano no banco.
const partnerBody=z.object({
  name:z.string().trim().min(2).max(160),
  email:z.string().trim().email().max(200),
  password:z.string().min(12).max(128),
  kind:z.enum(['content','reseller']).default('content'),
  planKey:z.string().min(3).max(32),
}).strict();
const partnerChanges=z.object({
 name:z.string().trim().min(2).max(160).optional(),
 planKey:z.string().min(3).max(32).optional(),
 contactName:z.string().trim().max(160).nullable().optional(),
 contactEmail:z.string().email().max(200).nullable().optional(),
 contactPhone:z.string().max(40).nullable().optional(),
 endsAt:z.coerce.date().optional(),
 status:z.enum(['active','suspended','blocked']).optional(),
}).strict().refine(v=>Object.keys(v).length>0,'Nenhuma mudança enviada.');
function assertQuota(req, field, used, code) { enforceLimit(req.user.networkLimits?.[field], used, code); }
function assertResourceQuota(req, { dnsLimit, activationLimit }) {
  const dnsCap=req.user.networkLimits?.maxDnsPerCode;
  const actCap=req.user.networkLimits?.maxActivationsPerPartner;
  if (dnsLimit !== undefined && dnsCap != null && (dnsLimit===null || dnsLimit===0 || dnsLimit>dnsCap))
    throw new AppError(403,"DNS_QUOTA_EXCEEDED","Sua rede não pode conceder esta quantidade de DNS.");
  if (activationLimit !== undefined && actCap != null && (activationLimit===null || activationLimit>actCap))
    throw new AppError(403,"ACTIVATION_QUOTA_EXCEEDED","Sua rede não pode conceder esta quantidade de ativações.");
}
function planFitsPartner(plan, kind) {
  return plan && plan.active && (plan.audience === "both" || (kind !== "both" && plan.audience === kind));
}
async function ownedPlan(adminId, key, kind, transaction) {
  const plan = await ServicePlanCatalog.findOne({where:{key,ownerAdminId:adminId,deletedAt:null},transaction});
  if (!planFitsPartner(plan,kind)) throw new AppError(422,"PLAN_NOT_IN_NETWORK","Plano inexistente, inativo ou incompatível com esta conta.");
  return plan;
}
async function ownedPartner(adminId,id,transaction,lock=false) {
  const p=await Partner.findOne({where:{id,ownerAdminId:adminId,status:{[Op.ne]:"deleted"}},transaction,
    ...(lock?{lock:transaction.LOCK.UPDATE}:{})});
  if(!p)throw new AppError(404,"NOT_FOUND","Parceiro não encontrado na sua rede.");
  return p;
}
function mapPage(rows,count,{page,pageSize}) {return {data:rows,meta:{page,pageSize,total:count,totalPages:Math.ceil(count/pageSize)}};}
function partnerStatusOut(p, { canSeeContract = true } = {}) {
  const data = p.toJSON ? p.toJSON() : { ...p };
  const effectiveStatus = effectivePartnerStatus(p);
  const pending = p.status === "suspended" && p.statusReason === SIGNUP_PENDING_REASON;
  // endsAt/statusReason are fetched to calculate expiration and 'Novo cadastro',
  // but do NOT leave the server when contractual visibility was not granted.
  if (!canSeeContract) {
    delete data.endsAt;
    delete data.slug;
    delete data.statusReason;
    delete data.monthlyFeeCents;
    delete data.deviceLimit;
  }
  return { ...data, effectiveStatus, pending };
}
async function verifyLimitsInUse(partnerId, input, transaction) {
  if(input.activationLimit !== undefined && input.activationLimit !== null) {
    const used=await Activation.count({where:{partnerId,status:{[Op.ne]:"revoked"}},transaction});
    if(used>input.activationLimit)throw new AppError(409,"ACTIVATION_LIMIT_BELOW_USAGE","O limite é menor que as ativações em uso.");
  }
  if(input.dnsLimit !== undefined && input.dnsLimit !== null && input.dnsLimit>0) {
    const [over]=await sequelize.query(`SELECT c.code FROM partner_codes c
      JOIN code_server_pools pool ON pool.code_id=c.id
      WHERE c.partner_id = :partnerId AND c.status='active'
      GROUP BY c.id,c.code HAVING count(pool.id) > :maxDns LIMIT 1`,
      {replacements:{partnerId,maxDns:input.dnsLimit},transaction});
    if(over.length)throw new AppError(409,"DNS_LIMIT_BELOW_USAGE","Um código já utiliza mais DNS que o limite solicitado.");
  }
}
async function applyOwnedTerms(partner, {activationLimit,dnsLimit,monthlyFeeCents,planKey}, transaction) {
  const current=await ContentPartnerTerms.findByPk(partner.id,{transaction,lock:transaction.LOCK.UPDATE});
  if(current?.mode==="credits")throw new AppError(409,"LEGACY_CREDITS_REQUIRE_RECONCILIATION","Uma conta com créditos precisa ser conciliada pela DeltaTV.");
  if(partner.kind !== "reseller" && (activationLimit!==undefined || monthlyFeeCents!==undefined)) {
    const limit=activationLimit!==undefined?activationLimit:(current?.activationLimit??partner.deviceLimit??null);
    const fee=monthlyFeeCents??current?.fixedFeeCents??partner.monthlyFeeCents;
    const terms={mode:limit===null?"fixed_unlimited":"fixed_limited",fixedFeeCents:fee,activationLimit:limit,
      licensePolicy:current?.licensePolicy??"partner_only",creditsPerActivation:current?.creditsPerActivation??1,
      autoPriority:current?.autoPriority??true,allowWebIssuance:current?.allowWebIssuance??false};
    if(current)await current.update(terms,{transaction});
    else await ContentPartnerTerms.create({partnerId:partner.id,...terms},{transaction});
  }
  let technical=await PartnerServicePlan.findByPk(partner.id,{transaction,lock:transaction.LOCK.UPDATE});
  if(planKey!==undefined || dnsLimit!==undefined) {
    const next={tier:planKey??technical?.tier??"partner_professional",
      maxServersOverride:dnsLimit!==undefined?dnsLimit:(technical?.maxServersOverride??null)};
    if(technical)await technical.update(next,{transaction});
    else technical=await PartnerServicePlan.create({partnerId:partner.id,...next},{transaction});
  }
}
function normalizeError(error){
  if(error instanceof UniqueConstraintError)throw new AppError(409,"ALREADY_REGISTERED","E-mail, identificador ou plano já cadastrado.");
  throw error;
}

router.get("/admins",async(req,res)=>{
  if(req.user.role!=="superadmin")throw new AppError(403,"DELTATV_ONLY","Operação exclusiva da DeltaTV.");
  const rows=await AdminUser.findAll({where:{role:"admin",deletedAt:null},attributes:["id","name","email","status","delegatedPermissions","networkLimits"],order:[["name","ASC"]]});
  res.json({data:rows});
});
// Histórico somente de parceiros pertencentes à rede autenticada.
// Não retorna registros globais de VPS, API ou dados de outra administração.
router.get('/audit',requireScope('network:audit:read'),async(req,res)=>{
 const [rows]=await sequelize.query(`SELECT l.id,l.action,l.result,l.created_at AS "createdAt",
   p.id AS "partnerId",p.name AS "partnerName"
   FROM audit_logs l JOIN partners p ON p.id::text=l.entity_id
   WHERE l.entity_type='partner' AND p.owner_admin_id IS NOT DISTINCT FROM CAST(:ownerId AS uuid)
   ORDER BY l.created_at DESC,l.id DESC LIMIT 100`,
  {replacements:{ownerId:tenant(req)}});
 res.json({data:rows});
});
router.get("/summary",requireScope("network:dashboard:read"),async(req,res)=>{
  const root=tenant(req);
  const [counts,plans]=await Promise.all([
    sequelize.query(`SELECT
      count(*) FILTER (WHERE kind IN ('content','both'))::int AS partners,
      count(*) FILTER (WHERE kind IN ('reseller','both'))::int AS resellers,
      count(*) FILTER (WHERE kind IN ('content','both') AND status='active' AND ends_at > :now)::int AS "activePartners",
      count(*) FILTER (WHERE kind IN ('reseller','both') AND status='active' AND ends_at > :now)::int AS "activeResellers",
      count(*) FILTER (WHERE status='active' AND ends_at <= :now)::int AS expired,
      count(*) FILTER (WHERE status='suspended' AND status_reason = :pendingReason)::int AS pending
      FROM partners WHERE owner_admin_id IS NOT DISTINCT FROM CAST(:root AS uuid) AND status <> 'deleted'`,
      {replacements:{root,now:new Date(),pendingReason:SIGNUP_PENDING_REASON}}),
    ServicePlanCatalog.count({where:{ownerAdminId:root,deletedAt:null}}),
  ]);
  const stats=counts[0][0];
  res.json({owner:{id:root,name:req.user.role==="admin"?req.user.name:"Admin selecionado"},
    ...stats,plans});
});
router.get("/plans",requireScope("network:plans:read"),async(req,res)=>{
  const rows=await ServicePlanCatalog.findAll({where:{ownerAdminId:tenant(req),deletedAt:null},order:[["createdAt","DESC"]]});
  res.json({data:rows});
});
router.post("/plans",requireScope("network:plans:write"),validate({body:packageBody}),async(req,res)=>{
  const adminId=tenant(req);const b=req.valid.body;
  assertResourceQuota(req,{dnsLimit:b.maxServers,activationLimit:b.activationLimit});
  let result;
  try {result=await sequelize.transaction(async t=>{
    // Serializa cadastros concorrentes na mesma rede antes de conferir as cotas.
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))",{replacements:{key:`network:${adminId}`},transaction:t});
    const used=await ServicePlanCatalog.count({where:{ownerAdminId:adminId},transaction:t});
    assertQuota(req,"maxPlans",used,"PLAN_QUOTA_EXCEEDED");
    // Chave aleatória (e globalmente única); a identidade da rede vem do proprietário no banco.
    const key=`n${randomBytes(12).toString("hex")}`;
    const plan=await ServicePlanCatalog.create({key,...b,ownerAdminId:adminId,sortOrder:100,
      system:false,active:true,canResellPanel:false,canCreateSubmasters:false,
      canViewFinance:false,canManageGateways:false},{transaction:t});
    await audit({actor:actorOf(req),action:"network.plan.create",entityType:"service_plan",entityId:key,metadata:{name:plan.name},transaction:t});
    return plan;
  });}catch(e){normalizeError(e)}
  res.status(201).json(result);
});
router.put("/plans/:key",requireScope("network:plans:write"),validate({params:z.object({key:z.string().min(2).max(32)}),
  body:packageFields.partial().extend({active:z.boolean().optional()}).strict().refine(v=>Object.keys(v).length>0)}),async(req,res)=>{
  const root=tenant(req),{key}=req.valid.params,body=req.valid.body;
  if(body.maxServers!==undefined||body.activationLimit!==undefined)assertResourceQuota(req,{dnsLimit:body.maxServers,activationLimit:body.activationLimit});
  const plan=await sequelize.transaction(async t=>{
    const p=await ServicePlanCatalog.findOne({where:{key,ownerAdminId:root,deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
    if(!p)throw new AppError(404,"NOT_FOUND","Plano não encontrado na sua rede.");
    if(body.active===false && await PartnerServicePlan.count({where:{tier:key},transaction:t}))
      throw new AppError(409,"PLAN_IN_USE","Um plano em uso não pode ser desativado sem reatribuir as contas.");
    if(body.maxServers!==undefined && body.maxServers!==null) {
      const [over]=await sequelize.query(`SELECT c.id FROM partner_service_plans s
        JOIN partners p ON p.id=s.partner_id
        JOIN partner_codes c ON c.partner_id=p.id AND c.status='active'
        JOIN code_server_pools pool ON pool.code_id=c.id
        WHERE p.owner_admin_id=:root AND s.tier=:key
          AND s.max_servers_override IS NULL
        GROUP BY c.id HAVING count(pool.id) > :max LIMIT 1`,
        {transaction:t,replacements:{root,key,max:body.maxServers}});
      if(over.length)throw new AppError(409,"PLAN_BELOW_USAGE","Há códigos com mais DNS do que o novo plano permite.");
    }
    const wasHidden=isHiddenNetworkPlan(p);
    await p.update(body,{transaction:t});
    if(body.hiddenFromNetwork!==undefined && wasHidden!==p.hiddenFromNetwork)
      await audit({actor:actorOf(req),action:"network.plan.visibility",entityType:"service_plan",entityId:key,
        metadata:{ownerAdminId:root,before:wasHidden,after:p.hiddenFromNetwork},transaction:t});
    if(p.autoPriority&&!p.autoFailover)throw new AppError(422,"INVALID_PLAN","Prioridade automática exige failover.");
    await audit({actor:actorOf(req),action:"network.plan.update",entityType:"service_plan",entityId:key,metadata:{fields:Object.keys(body)},transaction:t});
    return p;
  });
  invalidatePlan();invalidateServerPools();clearResolutionCache();res.json(plan);
});
// Excluir um plano da rede não pode remover um contrato já vinculado.
// Para planos referenciados, faz exclusão lógica (invisível para novos cadastros).
// Para planos sem vínculos, remove fisicamente o registro.
router.get("/plans/:key/deletion-preview",requireScope("network:plans:read"),
 validate({params:z.object({key:z.string().min(2).max(32)})}),async(req,res)=>{
  const {key}=req.valid.params,root=tenant(req);
  const plan=await ServicePlanCatalog.findOne({where:{key,ownerAdminId:root,deletedAt:null}});
  if(!plan)throw new AppError(404,"NOT_FOUND","Plano não encontrado na sua rede.");
  const [accounts,invitations]=await Promise.all([
   PartnerServicePlan.count({where:{tier:key}}),AdminNetworkInvitation.count({where:{planKey:key}}),
  ]);
  res.json({key,name:plan.name,accounts,invitations,mode:accounts||invitations?'archive':'physical',
   warning:accounts||invitations?'O plano será removido das listas e não poderá receber novos cadastros. Contratos e convites históricos serão preservados.':'O plano não tem contas ou convites vinculados e poderá ser removido permanentemente.'});
 });
router.delete("/plans/:key",requireScope("network:plans:write"),
 validate({params:z.object({key:z.string().min(2).max(32)}),body:z.object({reason:z.string().trim().max(500).optional().default("")}).strict()}),async(req,res)=>{
  const root=tenant(req),{key}=req.valid.params,{reason}=req.valid.body;
  const result=await sequelize.transaction(async t=>{
   await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))",{replacements:{key:`network:${root}`},transaction:t});
   const plan=await ServicePlanCatalog.findOne({where:{key,ownerAdminId:root,deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
   if(!plan)throw new AppError(404,"NOT_FOUND","Plano não encontrado na sua rede.");
   if(plan.system)throw new AppError(409,"SYSTEM_PLAN","Planos de sistema não podem ser excluídos.");
   const accounts=await PartnerServicePlan.count({where:{tier:key},transaction:t});
   const invitations=await AdminNetworkInvitation.count({where:{planKey:key},transaction:t});
   const mode=accounts||invitations?'archive':'physical';
   if(mode==='archive'){
    await plan.update({deletedAt:new Date(),active:false},{transaction:t});
    // Links de convite da rede ficam inválidos, sem apagar os registros já utilizados.
    await AdminNetworkInvitation.update({revokedAt:new Date()},
     {where:{planKey:key,revokedAt:null},transaction:t});
   }else{
    // Qualquer outra FK RESTRICT impede a exclusão no banco, sem perdas em cascata.
    await plan.destroy({transaction:t});
   }
   await audit({actor:actorOf(req),action:"network.plan.delete",entityType:"service_plan",entityId:key,
    metadata:{ownerAdminId:root,name:plan.name,reason,mode,accounts,invitations},transaction:t});
   return {ok:true,mode,accounts,invitations};
  });
  invalidatePlan();invalidateServerPools();clearResolutionCache();res.json(result);
 });
// Consultas de recursos são sempre vinculadas a uma conta do mesmo titular.
// Permitir a seleção de conta sem conceder leitura da ficha comercial inteira.
const INDIRECT_ACCOUNT_READS=Object.freeze([
  "network:resources:read","network:devices:read","network:billing:read","network:members:read",
]);
const hasIndirectAccountRead=req=>INDIRECT_ACCOUNT_READS.some(p=>adminHasNetworkPermission(req.user,p));
router.get("/partners",validate({query:listQuery}),async(req,res)=>{
  const {page,pageSize,q,kind,status}=req.valid.query;
  const indirect=hasIndirectAccountRead(req);
  const directPartners=adminHasNetworkPermission(req.user,"network:partners:read"),
    directResellers=adminHasNetworkPermission(req.user,"network:resellers:read");
  if(!directPartners && !directResellers && !indirect)
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","Consulta não autorizada.");
  if(kind==="reseller"&&!directResellers&&!indirect || kind==="content"&&!directPartners&&!indirect)
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","Consulta não autorizada.");
  const mayPartner=directPartners||indirect, mayReseller=directResellers||indirect;
  const types=kind === "both"?(mayPartner&&mayReseller?["both"]:[]):
    kind?[kind,...(mayPartner&&mayReseller?["both"]:[])]:[
      ...(mayPartner?["content"]:[]),...(mayReseller?["reseller"]:[]),
      ...(mayPartner&&mayReseller?["both"]:[])];
  const where={ownerAdminId:tenant(req),kind:{[Op.in]:types},...partnerStatusWhere(status)};
  if(q){const search=`%${q.replace(/[%_\\]/g,"")}%`;where[Op.or]=[{name:{[Op.iLike]:search}},{contactEmail:{[Op.iLike]:search}},{slug:{[Op.iLike]:search}}]}
  const canSeeContract=directPartners||directResellers||adminHasNetworkPermission(req.user,"network:billing:read");
  const attributes=canSeeContract?["id","name","slug","kind","status","statusReason","monthlyFeeCents","deviceLimit","endsAt","createdAt"]:
    ["id","name","kind","status","statusReason","endsAt","createdAt"];
  const {rows,count}=await Partner.findAndCountAll({where,attributes,
    order:[["createdAt","DESC"],["id","ASC"]],offset:(page-1)*pageSize,limit:pageSize});
  const maySeeContract = p => adminHasNetworkPermission(req.user,"network:billing:read") ||
    (p.kind === "reseller" ? directResellers : p.kind === "both" ? directPartners && directResellers : directPartners);
  res.json(mapPage(rows.map(p=>partnerStatusOut(p,{canSeeContract:maySeeContract(p)})),count,{page,pageSize}));
});
router.post('/partners',validate({body:partnerBody}),async(req,res)=>{
 const b=req.valid.body,root=tenant(req),perm=b.kind==='reseller'?'network:resellers:write':'network:partners:write';
 if(!adminHasNetworkPermission(req.user,perm))throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para cadastrar esta conta.');
 const email=b.email.toLowerCase();
 // Hash antes de abrir a transação e seus locks.
 const passwordHash=await hashPassword(b.password);
 let result;
 try{result=await sequelize.transaction(async transaction=>{
   await lockNetworkOwner(root,transaction);
   const plan=await scopedPlan(root,b.planKey,b.kind,transaction);
   const created=await provisionNetworkAccount({ownerId:root,actor:actorOf(req),plan,
     name:b.name,email,passwordHash,kind:b.kind,limits:req.user.networkLimits||{},transaction});
   return {id:created.partner.id,name:created.partner.name,kind:b.kind};
 });}catch(e){normalizeError(e)}
 invalidatePlan(result.id);invalidateServerPools();clearResolutionCache();clearContractAccessCache();
 res.status(201).json(result);
});
router.get("/partners/:id",validate({params:ident}),async(req,res)=>{
  const root=tenant(req),p=await ownedPartner(root,req.valid.params.id);
  const directPartner=adminHasNetworkPermission(req.user,"network:partners:read"),
    directReseller=adminHasNetworkPermission(req.user,"network:resellers:read"),
    indirect=hasIndirectAccountRead(req);
  const direct=p.kind==="reseller"?directReseller:p.kind==="both"?directPartner&&directReseller:directPartner;
  if(!direct&&!indirect)throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem acesso à conta.");
  const mayFinancial=direct||adminHasNetworkPermission(req.user,"network:billing:read");
  const [terms,plan,users]=await Promise.all([
    mayFinancial?ContentPartnerTerms.findByPk(p.id):Promise.resolve(null),
    direct||adminHasNetworkPermission(req.user,"network:plans:read")?PartnerServicePlan.findByPk(p.id):Promise.resolve(null),
    adminHasNetworkPermission(req.user,"network:members:read")?
      AdminUser.findAll({where:{partnerId:p.id,role:"partner",deletedAt:null},attributes:["id","name","email","status","createdAt"]}):Promise.resolve([])]);
  // Selecionar uma conta para visualizar dispositivos não revela credenciais ou contrato.
  const partner=direct?partnerStatusOut(p):partnerStatusOut(p,{canSeeContract:false});
  if(!direct){for(const key of Object.keys(partner)) if(!["id","name","kind","status","effectiveStatus","pending"].includes(key))delete partner[key];}
  res.json({partner,contract:terms,plan,users});
});
router.patch('/partners/:id',validate({params:ident,body:partnerChanges}),async(req,res)=>{
 const root=tenant(req),b=req.valid.body;
 const updated=await sequelize.transaction(async t=>{
  const p=await ownedPartner(root,req.valid.params.id,t,true);
  const perm=p.kind==='reseller'?'network:resellers:write':'network:partners:write';
  if(!adminHasNetworkPermission(req.user,perm) ||
    (p.kind==='both'&&!adminHasNetworkPermission(req.user,'network:resellers:write')))
   throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para alterar a conta.');
  if(b.endsAt && b.endsAt<=p.startsAt)throw new AppError(422,'INVALID_PERIOD','Vencimento inválido.');
  if(p.statusReason==='awaiting_payment' && b.status==='active')
   throw new AppError(409,'PAYMENT_CONFIRMATION_REQUIRED','Confirme o pagamento na área financeira antes de ativar esta conta.');
  // O preço, a cota de DNS e as ativações não chegam do navegador: vêm do plano.
  let changes={...b};
  if(b.planKey!==undefined){
   const current=await PartnerServicePlan.findByPk(p.id,{transaction:t,lock:t.LOCK.UPDATE});
   const plan=await scopedPlan(root,b.planKey,p.kind,t);
   checkPlanCaps(plan,req.user.networkLimits||{});
   if(current?.tier!==plan.key){
    // Trocar para um plano pago nunca equivale a confirmar o seu pagamento.
    if(plan.monthlyPriceCents>0){changes.status='suspended';changes.statusReason='awaiting_payment';}
    else {const now=new Date();changes.status='active';changes.statusReason=null;
      changes.startsAt=now;changes.endsAt=new Date(now.getTime()+plan.validityDays*86400_000);}
   }
   await verifyLimitsInUse(p.id,{activationLimit:plan.activationLimit,dnsLimit:plan.maxServers},t);
   changes.deviceLimit=plan.activationLimit;
   changes.monthlyFeeCents=plan.monthlyPriceCents;
   changes.billingModel='fixed';
   await applyOwnedTerms(p,{planKey:plan.key,activationLimit:plan.activationLimit,
    dnsLimit:plan.maxServers,monthlyFeeCents:plan.monthlyPriceCents},t);
   if(p.kind!=='reseller')await ContentPartnerTerms.update({autoPriority:plan.autoPriority},{where:{partnerId:p.id},transaction:t});
  }
  delete changes.planKey;
  await p.update(changes,{transaction:t});
  await audit({actor:actorOf(req),action:'network.partner.update',entityType:'partner',entityId:p.id,
    metadata:{fields:Object.keys(b),ownerAdminId:root},transaction:t});
  return p;
 });
 invalidatePlan(updated.id);invalidateServerPools();clearResolutionCache();clearContractAccessCache();
 res.json({id:updated.id,status:updated.status,effectiveStatus:effectivePartnerStatus(updated)});
});
// Same transition rules as Superadmin, with an owner check inside the locked service.
// The route never grants `force` to Admins, even when the client sends it.
for(const action of ["suspend","block","reactivate","cancel"]){
 router.post(`/partners/:id/${action}`,validate({params:ident,
   body:z.object({reason:z.string().trim().max(500).optional()}).strict()}),async(req,res)=>{
   const owned=await ownedPartner(tenant(req),req.valid.params.id);
   const perm=owned.kind==="reseller"?"network:resellers:write":"network:partners:write";
   if(!adminHasNetworkPermission(req.user,perm) ||
       (owned.kind==="both"&&!adminHasNetworkPermission(req.user,"network:resellers:write")))
     throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para alterar esta conta.");
   if(action==="reactivate" && owned.statusReason==="awaiting_payment")
     throw new AppError(409,"PAYMENT_CONFIRMATION_REQUIRED","Confirme o pagamento antes de reativar.");
   // Never allow a delegated admin to reactivate a cancelled account by forcing it.
   const updated=await codesService.changePartnerStatus(owned.id,action,req.valid.body,actorOf(req),tenant(req));
   clearContractAccessCache();invalidatePlan(updated.id);
   res.json({id:updated.id,status:updated.status,effectiveStatus:effectivePartnerStatus(updated)});
 });
}
// A conta de plano pago só ativa com confirmação deliberada do recebimento;
// a auditoria não deve tratar criação de conta como pagamento.
// Exclusão lógica da própria rede: valida proprietário, permissão e confirmação.
// Registros financeiros e os dados de outros titulares não são apagados.
function canDeleteOwned(req,p){
 const basic=p.kind==='reseller'?'network:resellers:delete':'network:partners:delete';
 if(!adminHasNetworkPermission(req.user,basic) ||
    (p.kind==='both'&&!adminHasNetworkPermission(req.user,'network:resellers:delete')))
  throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para excluir esta conta.');
}
router.get('/partners/:id/delete-preview',validate({params:ident}),async(req,res)=>{
 const p=await ownedPartner(tenant(req),req.valid.params.id);canDeleteOwned(req,p);
 const data=await partnerDeletionPreview(p.id,actorOf(req),tenant(req));
 res.json(data);
});
router.post('/partners/:id/archive',validate({params:ident,body:z.object({
 reason:z.string().trim().max(500).optional().default(""),
 deleteClients:z.boolean().default(false),deleteDevices:z.boolean().default(false),
}).strict()}),async(req,res)=>{
 const p=await ownedPartner(tenant(req),req.valid.params.id);canDeleteOwned(req,p);
 const result=await deletePartnerAsSuper(p.id,{...req.valid.body,confirmation:p.name,reason:req.valid.body.reason||"Exclusão solicitada pelo administrador"},actorOf(req),tenant(req));
 res.json(result);
});
// Lixeira operacional isolada por owner; exclusão definitiva continua exclusiva da DeltaTV.
// Para contas do tipo "both" são necessárias as duas permissões de exclusão.
router.get('/trash',validate({query:listQuery}),async(req,res)=>{
  const rights={content:adminHasNetworkPermission(req.user,'network:partners:delete'),
    reseller:adminHasNetworkPermission(req.user,'network:resellers:delete')};
  if(!rights.content&&!rights.reseller)throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para consultar a lixeira.');
  const kinds=[...(rights.content?['content']:[]),...(rights.reseller?['reseller']:[]),
    ...(rights.content&&rights.reseller?['both']:[])];
  if(req.valid.query.kind&& !kinds.includes(req.valid.query.kind))
    throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para este tipo de conta.');
  res.json(await listPartnerTrash(req.valid.query,actorOf(req),tenant(req),
    req.valid.query.kind?[req.valid.query.kind]:kinds));
});
router.post('/trash/:id/restore',validate({params:ident,
  body:z.object({reason:z.string().trim().min(8).max(400)}).strict()}),async(req,res)=>{
  const p=await Partner.findOne({where:{id:req.valid.params.id,ownerAdminId:tenant(req),status:'deleted'},
    attributes:['id','kind','status']});
  if(!p)throw new AppError(404,'NOT_FOUND','Conta não encontrada na lixeira da sua rede.');
  canDeleteOwned(req,p);
  res.json(await restorePartnerFromTrash(p.id,req.valid.body,actorOf(req),tenant(req)));
});
router.post('/partners/:id/confirm-payment',validate({params:ident,
 body:z.object({reference:z.string().trim().min(5).max(160)}).strict()}),async(req,res)=>{
 if(!adminHasNetworkPermission(req.user,'network:billing:write'))
   throw new AppError(403,'NETWORK_PERMISSION_DENIED','Confirmação exige permissão financeira.');
 const p=await ownedPartner(tenant(req),req.valid.params.id);
 const perm=p.kind==='reseller'?'network:resellers:write':'network:partners:write';
 if(!adminHasNetworkPermission(req.user,perm) ||
    (p.kind==='both'&&!adminHasNetworkPermission(req.user,'network:resellers:write')))
   throw new AppError(403,'NETWORK_PERMISSION_DENIED','Sem permissão para alterar esta conta.');
 const result=await confirmPendingContractFromWorkspace(tenant(req),p.id,req.valid.body.reference,actorOf(req));
 res.json({id:p.id,payment:result,effectiveStatus:result.applied?'active':effectivePartnerStatus(p)});
});
router.post("/partners/:id/users",validate({params:ident,body:account}),async(req,res)=>{
  const partner=await ownedPartner(tenant(req),req.valid.params.id);
  if(!adminHasNetworkPermission(req.user,"network:members:write"))throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para gerenciar usuários.");
  try{const u=await sequelize.transaction(async t=>{
    const created=await AdminUser.create({name:req.valid.body.name,email:req.valid.body.email,
      passwordHash:await hashPassword(req.valid.body.password),role:"partner",partnerId:partner.id},{transaction:t});
    await audit({actor:actorOf(req),action:"network.user.create",entityType:"admin_user",entityId:created.id,
      metadata:{partnerId:partner.id},transaction:t});return created;
  });res.status(201).json({id:u.id,name:u.name,email:u.email});}catch(e){normalizeError(e)}
});
router.patch("/partners/:id/users/:userId",validate({params:z.object({id:z.string().uuid(),userId:z.string().uuid()}),
  body:z.object({status:z.enum(["active","disabled"]).optional(),name:z.string().trim().min(2).max(160).optional(),email:z.string().trim().email().max(200).optional(),password:z.string().min(12).max(128).optional()}).strict().refine(v=>Object.keys(v).length>0)}),async(req,res)=>{
  if(!adminHasNetworkPermission(req.user,"network:members:write"))throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para gerenciar usuários.");
  await sequelize.transaction(async t=>{
    await ownedPartner(tenant(req),req.valid.params.id,t,true);
    const u=await AdminUser.findOne({where:{id:req.valid.params.userId,partnerId:req.valid.params.id,role:"partner",deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
    if(!u)throw new AppError(404,"NOT_FOUND","Usuário não encontrado nesta parceria.");
    const changes={...req.valid.body};
    if(changes.email && changes.email.toLowerCase()!==u.email.toLowerCase()){
      const clash=await AdminUser.findOne({where:{email:{[Op.iLike]:changes.email},deletedAt:null,id:{[Op.ne]:u.id}},transaction:t});
      if(clash)throw new AppError(409,"EMAIL_IN_USE","Este e-mail já pertence a outra conta.");
    }
    if(changes.password){changes.passwordHash=await hashPassword(changes.password);delete changes.password;}
    await u.update(changes,{transaction:t});
    await AdminUser.increment("tokenVersion",{where:{id:u.id},transaction:t});
    await audit({actor:actorOf(req),action:"network.user.update",entityType:"admin_user",entityId:u.id,metadata:{fields:Object.keys(req.valid.body)},transaction:t});
  });res.json({ok:true});
});
router.delete("/partners/:id/users/:userId",requireScope("network:members:write"),validate({
  params:z.object({id:z.string().uuid(),userId:z.string().uuid()}),
  body:z.object({reason:z.string().trim().max(400).optional().default("")}).strict(),
}),async(req,res)=>{
  await sequelize.transaction(async t=>{
    await ownedPartner(tenant(req),req.valid.params.id,t,true);
    const u=await AdminUser.findOne({where:{id:req.valid.params.userId,partnerId:req.valid.params.id,role:"partner",deletedAt:null},transaction:t,lock:t.LOCK.UPDATE});
    if(!u)throw new AppError(404,"NOT_FOUND","Usuário não encontrado nesta conta.");
    await u.update({status:"disabled",deletedAt:new Date(),tokenVersion:Number(u.tokenVersion||0)+1},{transaction:t});
    await audit({actor:actorOf(req),action:"network.user.archive",entityType:"admin_user",entityId:u.id,metadata:{partnerId:u.partnerId,reason:req.valid.body.reason},transaction:t});
  });
  res.json({archived:true});
});
// Recursos e faturamento: serviços existentes, mas SOMENTE depois de comprovar
// proprietário da parceria. ID informado na URL não é uma fonte de autorização.
const codeInput=z.object({
  code:z.string().min(4).max(12).optional(),label:z.string().trim().max(120).optional(),
  providerId:z.string().uuid().nullable().optional(),
  maxActivations:z.number().int().min(1).max(2147483647).nullable().optional(),
  expiresAt:z.coerce.date().nullable().optional(),
}).strict();
const providerInput=z.object({
  name:z.string().trim().min(2).max(120),baseUrl:z.string().trim().max(500),
  playlistTemplate:z.string().max(500).default(DEFAULT_TEMPLATE),
  deliveryMode:z.enum(["redirect","proxy"]).default("redirect"),
  priority:z.number().int().min(0).max(1000).default(0),
  status:z.enum(["active","disabled"]).default("active"),
}).strict();
const pagination=z.object({page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(30)});
router.get("/partners/:id/codes",requireScope("network:resources:read"),validate({params:ident}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json({data:await codesService.listCodes(p.id)});
});
router.post("/partners/:id/codes",requireScope("network:resources:write"),validate({params:ident,body:codeInput}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  // Códigos de Revenda dependem de uma licença de TV e do respectivo financeiro.
  // Não fabricar uma licença passando licenseMonths:null para o serviço legado.
  if(p.kind==="reseller")
    throw new AppError(403,"RESELLER_LICENSE_DELEGATION_REQUIRED","Códigos de revenda exigem uma licença de TV previamente autorizada. Utilize o fluxo de licenças da DeltaTV.");
  const requested=req.valid.body.maxActivations;
  const cap=req.user.networkLimits?.maxActivationsPerPartner;
  if(requested !== undefined && (cap != null && (requested===null || requested>cap) ||
      p.deviceLimit != null && (requested===null || requested>p.deviceLimit)))
    throw new AppError(403,"CODE_ACTIVATION_QUOTA","Este código excede o limite de ativações autorizado para a conta.");
  // Nenhuma emissão de estoque/licença de TV é autorizada por essa permissão.
  res.status(201).json(await codesService.createCode(p.id,{...req.valid.body,licenseMonths:null},actorOf(req)));
});
// Edição e revogação delegadas somente após validar o titular da parceria.
// Exclusão irreversível e movimentação de licenças de TV seguem exclusivas da DeltaTV.
const ownedCodeParams=z.object({id:z.string().uuid(),codeId:z.string().uuid()});
const codeEditInput=codeInput.omit({code:true}).partial().strict()
  .refine(v=>Object.keys(v).length>0,{message:"Nenhuma alteração informada."});
router.patch("/partners/:id/codes/:codeId",requireScope("network:resources:write"),
  validate({params:ownedCodeParams,body:codeEditInput}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const requested=req.valid.body.maxActivations,cap=req.user.networkLimits?.maxActivationsPerPartner;
  if(requested!==undefined && (cap!=null&&(requested===null||requested>cap) ||
       p.deviceLimit!=null&&(requested===null||requested>p.deviceLimit)))
    throw new AppError(403,"CODE_ACTIVATION_QUOTA","O código excede o limite permitido.");
  res.json(await codesService.updateCode(p.id,req.valid.params.codeId,req.valid.body,actorOf(req)));
});
router.post("/partners/:id/codes/:codeId/revoke",requireScope("network:resources:write"),
  validate({params:ownedCodeParams}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  await codesService.revokeCode(p.id,req.valid.params.codeId,actorOf(req));
  res.status(204).end();
});
router.get("/partners/:id/providers",requireScope("network:resources:read"),validate({params:ident}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json({data:await providerService.listProviders(p.id)});
});
router.post("/partners/:id/providers",requireScope("network:resources:write"),validate({params:ident,body:providerInput}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.status(201).json(await providerService.createProvider(p.id,req.valid.body,actorOf(req)));
});
router.patch("/partners/:id/providers/:providerId",requireScope("network:resources:write"),validate({
  params:z.object({id:z.string().uuid(),providerId:z.string().uuid()}),
  body:providerInput.partial().strict().refine(value=>Object.keys(value).length>0),
}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await providerService.updateProvider(p.id,req.valid.params.providerId,req.valid.body,actorOf(req)));
});
// Exclusão operacional com preview: usa as mesmas garantias do parceiro/Superadmin.
// Requer propriedade da conta, permissão explícita e confirmação literal.
const resourceDeleteInput=z.object({reason:z.string().trim().max(400).optional().default(""),
  replacementProviderId:z.string().uuid().nullable().optional(),force:z.boolean().optional()}).strict();
router.get("/partners/:id/codes/:codeId/deletion-preview",requireScope("network:resources:write"),validate({params:ownedCodeParams}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await codeDeletionPreview(p.id,req.valid.params.codeId));
});
router.delete("/partners/:id/codes/:codeId",requireScope("network:resources:write"),validate({params:ownedCodeParams,body:resourceDeleteInput}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const code=await PartnerCode.findOne({where:{id:req.valid.params.codeId,partnerId:p.id,deletedAt:null}});
  if(!code)throw new AppError(404,"NOT_FOUND","Código não encontrado.");
  res.json(await deleteCodeOperational(p.id,req.valid.params.codeId,{...req.valid.body,confirmation:code.code},actorOf(req)));
});
const ownedProviderParams=z.object({id:z.string().uuid(),providerId:z.string().uuid()});
router.get("/partners/:id/providers/:providerId/deletion-preview",requireScope("network:resources:write"),validate({params:ownedProviderParams}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await providerDeletionPreview(p.id,req.valid.params.providerId));
});
router.delete("/partners/:id/providers/:providerId",requireScope("network:resources:write"),validate({params:ownedProviderParams,body:resourceDeleteInput}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const provider=await PartnerProvider.findOne({where:{id:req.valid.params.providerId,partnerId:p.id,deletedAt:null}});
  if(!provider)throw new AppError(404,"NOT_FOUND","Servidor não encontrado.");
  res.json(await deleteProviderOperational(p.id,req.valid.params.providerId,{...req.valid.body,confirmation:provider.name},actorOf(req)));
});
// A mesma API lógica de Devices.jsx, mas limitada pelo proprietário da sessão.
// Nunca usa o cadastro global como autorização: MACs podem ser compartilhados.
const scopedDeviceFilter = pagination.extend({
  q:z.string().trim().max(40).optional(), status:z.enum(["active","blocked","revoked","unlinked"]).optional(),
  online:z.enum(["true","false"]).optional(),showRemoved:z.enum(["true","false"]).transform(v=>v==="true").optional(),
});
const scopedDeviceActionBody = z.object({reason:z.string().trim().max(500).optional().default("")}).strict();
const scopedDeviceDeleteBody = z.object({confirmMac:z.string().trim().min(11).max(30),reason:z.string().trim().min(3).max(500)}).strict();
router.get("/devices/by-mac",requireScope("network:devices:read"),validate({query:scopedDeviceFilter}),async(req,res)=>
  res.json(await listDevices(req.valid.query,{ownerAdminId:tenant(req)})));
router.get("/devices/history",requireScope("network:devices:read"),validate({query:pagination.extend({mac:z.string().trim().min(11).max(20)})}),async(req,res)=>
  res.json(await deviceHistory(req.valid.query.mac,req.valid.query,{ownerAdminId:tenant(req)})));
router.get("/devices/registrations/:id",requireScope("network:devices:read"),validate({params:ident}),async(req,res)=>
  res.json(await registeredDeviceById(req.valid.params.id,{ownerAdminId:tenant(req)})));
router.get("/devices/registrations/:id/attribution",requireScope("network:devices:read"),validate({params:ident}),async(req,res)=>
  res.json(await deviceAttribution(req.valid.params.id,{ownerAdminId:tenant(req)})));
router.get("/devices/registrations/:id/deletion-preview",requireScope("network:devices:write"),validate({params:ident}),async(req,res)=>
  res.json(await deviceDeletionPreviewScoped(req.valid.params.id,tenant(req))));
router.post("/devices/register",requireScope("network:devices:write"),validate({body:z.object({
  mac:z.string().trim().min(11).max(20),code:z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/),
  username:z.string().trim().min(1).max(128),password:z.string().min(1).max(128),
}).strict()}),async(req,res)=>{
  await scopedCode(req.valid.body.code,tenant(req));
  res.status(201).json(await registerDeviceFromPanel(req.valid.body,actorOf(req),{ownerAdminId:tenant(req)}));
});
router.post("/devices/registrations/:id/configuration",requireScope("network:devices:write"),validate({params:ident,body:z.object({
  mode:z.literal("partner"),confirm:z.literal(true),code:z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/),
  username:z.string().trim().min(1).max(128),password:z.string().min(1).max(128),
}).strict()}),async(req,res)=>{
  await ownedDevice(req.valid.params.id,tenant(req));
  await scopedCode(req.valid.body.code,tenant(req));
  res.json(await configureDeviceByAdmin(req.valid.params.id,req.valid.body,actorOf(req),{ownerAdminId:tenant(req)}));
});
router.post("/devices/activations/:id/:action",requireScope("network:devices:write"),validate({
  params:z.object({id:z.string().uuid(),action:z.enum(["block","unblock","revoke","restore"])}),body:scopedDeviceActionBody,
}),async(req,res)=>{
  const a=await ownedActivation(req.valid.params.id,tenant(req));
  await changeActivation(a.id,req.valid.params.action,{reason:req.valid.body.reason,actor:actorOf(req),
    scope:{partnerId:a.partnerId,ownerAdminId:tenant(req)},blockedBy:"partner"});
  res.json(await getActivation(a.id,{partnerId:a.partnerId,ownerAdminId:tenant(req)}));
});
router.delete("/devices/activations/:id",requireScope("network:devices:write"),validate({params:ident,body:scopedDeviceDeleteBody}),async(req,res)=>{
  const a=await ownedActivation(req.valid.params.id,tenant(req));
  res.json(await deleteScopedActivation(a.id,req.valid.body,actorOf(req),{partnerId:a.partnerId,ownerAdminId:tenant(req)}));
});
router.get("/devices/activations/:id/deletion-preview",requireScope("network:devices:write"),validate({params:ident}),async(req,res)=>{
  const a=await ownedActivation(req.valid.params.id,tenant(req));
  const otherActivations=await Activation.count({where:{deviceId:a.deviceId,id:{[Op.ne]:a.id}},
    include:[{model:Partner,attributes:[],required:true,where:{ownerAdminId:tenant(req)}}]});
  res.json({id:a.id,mac:a.mac,status:a.status,otherActivations});
});
for (const action of ["block","unblock","revoke","restore"]) router.post(`/devices/registrations/:id/${action}`,
  requireScope("network:devices:write"),validate({params:ident,body:scopedDeviceActionBody}),async(req,res)=>{
    res.json(await scopedDeviceAction(req.valid.params.id,action,req.valid.body,actorOf(req),tenant(req)));
  });
router.delete("/devices/registrations/:id",requireScope("network:devices:write"),validate({params:ident,body:scopedDeviceDeleteBody}),async(req,res)=>{
  res.json(await scopedDeviceAction(req.valid.params.id,"delete",req.valid.body,actorOf(req),tenant(req)));
});
router.post("/devices/bulk-action",requireScope("network:devices:write"),validate({body:z.object({
  ids:z.array(z.string().uuid()).min(1).max(25),action:z.enum(["block","unblock","revoke","restore","delete"]),
  reason:z.string().trim().max(500).optional().default(""),confirmation:z.literal("EXCLUIR").optional(),
}).strict()}),async(req,res)=>{
  const {ids,action,reason,confirmation}=req.valid.body;
  if(action==="delete" && confirmation!=="EXCLUIR")throw new AppError(422,"CONFIRMATION_REQUIRED","Digite EXCLUIR.");
  res.json(await bulkScopedDevices(action,ids,{reason},actorOf(req),tenant(req)));
});
router.get("/partners/:id/devices",requireScope("network:devices:read"),validate({params:ident,query:pagination.extend({q:z.string().trim().max(40).optional(),status:z.enum(["active","blocked","revoked"]).optional(),showRemoved:z.enum(["true","false"]).transform(v=>v==="true").optional()})}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await listActivations({...req.valid.query,partnerId:p.id},{partnerId:p.id}));
});
// Gestão operacional de TVs pertencentes à conta, validada pelo escopo da rede.
const activationDeleteRequest = z.object({ confirmMac:z.string().trim().min(11).max(30), reason:z.string().trim().min(3).max(500) }).strict();
const deviceBulkRequest = z.object({ ids:z.array(z.string().uuid()).min(1).max(100), reason:z.string().trim().min(3).max(500), confirmation:z.literal("EXCLUIR").optional() }).strict();
router.delete("/partners/:id/devices/:activationId",requireScope("network:devices:write"),validate({
  params:z.object({id:z.string().uuid(),activationId:z.string().uuid()}),body:activationDeleteRequest
}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await deleteScopedActivation(req.valid.params.activationId,req.valid.body,actorOf(req),{partnerId:p.id}));
});
for(const action of ["delete","revoke"]) router.post(`/partners/:id/devices/bulk-${action}`,
  requireScope("network:devices:write"),validate({params:ident,body:deviceBulkRequest}),async(req,res)=>{
    const p=await ownedPartner(tenant(req),req.valid.params.id);
    if(action==="delete" && req.valid.body.confirmation!=="EXCLUIR")throw new AppError(422,"CONFIRMATION_REQUIRED","Digite EXCLUIR.");
    res.json(await bulkScopedActivation(action,req.valid.body.ids,req.valid.body,actorOf(req),{partnerId:p.id}));
  });
router.post("/partners/:id/devices/:activationId/:action",requireScope("network:devices:write"),validate({
  params:z.object({id:z.string().uuid(),activationId:z.string().uuid(),action:z.enum(["block","unblock","revoke"])}),
  body:z.object({reason:z.string().trim().max(500).optional().default("")}).strict(),
}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const {activationId,action}=req.valid.params;
  await changeActivation(activationId,action,{reason:req.valid.body.reason,actor:actorOf(req),scope:{partnerId:p.id},blockedBy:"partner"});
  res.json(await getActivation(activationId,{partnerId:p.id}));
});
router.get("/partners/:id/invoices",requireScope("network:billing:read"),validate({params:ident}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const invoices=await Invoice.findAll({where:{partnerId:p.id},order:[["createdAt","DESC"]],limit:60});
  res.json({data:invoices});
});
router.post("/partners/:id/invoices",requireScope("network:billing:write"),validate({params:ident,
  body:z.object({competence:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict(),
}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  const result=await generateInvoice(p.id,req.valid.body.competence,actorOf(req));
  res.status(result.created?201:200).json(result);
});

export default router;
