import { Router } from "express";
import { z } from "zod";
import { Op, UniqueConstraintError } from "sequelize";
import { randomBytes } from "node:crypto";
import { sequelize, AdminUser, Partner, PartnerServicePlan, ContentPartnerTerms,
  ServicePlanCatalog, Activation, Invoice } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import * as codesService from "../partners/partner.service.js";
import * as providerService from "../providers/provider.service.js";
import { DEFAULT_TEMPLATE } from "../providers/playlist-url.js";
import {listActivations} from "../devices/device.service.js";
import {generateInvoice} from "../billing/billing.service.js";
import { AppError } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { invalidatePlan } from "../service-plans/plan.service.js";
import {invalidateServerPools} from "../provider-monitor/code-pool.service.js";
import {clearResolutionCache} from "../provider-monitor/resolve.service.js";
import { clearContractAccessCache } from "../access/access.service.js";
import { adminHasNetworkPermission, enforceLimit } from "./permissions.js";

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
const ident = z.object({ id: z.string().uuid() });
const listQuery = z.object({ page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20), q: z.string().trim().max(100).optional(),
  kind: z.enum(["content","reseller","both"]).optional() });
const intLimit = z.number().int().min(0).max(2147483647).nullable();
const packageFields = z.object({
  name: z.string().trim().min(3).max(120), description: z.string().trim().max(500).default(""),
  audience: z.enum(["content","reseller","both"]), monthlyPriceCents: z.number().int().min(0).max(100000000),
  maxServers: intLimit, autoFailover: z.boolean(), autoPriority: z.boolean(),
  emailAlerts: z.boolean(), detailedHistory: z.boolean(),
}).strict();
const packageBody = packageFields.refine(v=>v.autoFailover || !v.autoPriority,{path:["autoPriority"],message:"Prioridade exige failover."});
const account = z.object({name:z.string().trim().min(2).max(160), email:z.string().trim().email().max(200), password:z.string().min(12).max(128)}).strict();
const partnerBody = z.object({
  name: z.string().trim().min(2).max(160), slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/),
  kind:z.enum(["content","reseller","both"]), planKey:z.string().min(3).max(32),
  monthlyFeeCents:z.number().int().min(0).max(100000000), activationLimit:intLimit, dnsLimit:intLimit,
  endsAt:z.coerce.date(), contactName:z.string().trim().max(160).optional(),
  contactEmail:z.string().email().max(200).optional(), contactPhone:z.string().max(40).optional(),
  portalUser:account,
}).strict();
const partnerChanges = partnerBody.omit({slug:true,kind:true,portalUser:true}).partial().extend({
  name:z.string().trim().min(2).max(160).optional(),
  contactName:z.string().trim().max(160).nullable().optional(),
  contactEmail:z.string().email().max(200).nullable().optional(),
  contactPhone:z.string().max(40).nullable().optional(),
  status:z.enum(["active","suspended","blocked"]).optional(),
}).strict().refine(v=>Object.keys(v).length>0,"Nenhuma mudança enviada.");
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
  const plan = await ServicePlanCatalog.findOne({where:{key,ownerAdminId:adminId},transaction});
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
router.get("/summary",requireScope("network:dashboard:read"),async(req,res)=>{
  const root=tenant(req);
  const [partners,resellers,plans]=await Promise.all([
    Partner.count({where:{ownerAdminId:root,kind:{[Op.in]:["content","both"]},status:{[Op.ne]:"deleted"}}}),
    Partner.count({where:{ownerAdminId:root,kind:{[Op.in]:["reseller","both"]},status:{[Op.ne]:"deleted"}}}),
    ServicePlanCatalog.count({where:{ownerAdminId:root}}),
  ]);
  res.json({owner:{id:root,name:req.user.role==="admin"?req.user.name:"Admin selecionado"},partners,resellers,plans});
});
router.get("/plans",requireScope("network:plans:read"),async(req,res)=>{
  const rows=await ServicePlanCatalog.findAll({where:{ownerAdminId:tenant(req)},order:[["createdAt","DESC"]]});
  res.json({data:rows});
});
router.post("/plans",requireScope("network:plans:write"),validate({body:packageBody}),async(req,res)=>{
  const adminId=tenant(req);const b=req.valid.body;
  assertResourceQuota(req,{dnsLimit:b.maxServers});
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
  if(body.maxServers!==undefined)assertResourceQuota(req,{dnsLimit:body.maxServers});
  const plan=await sequelize.transaction(async t=>{
    const p=await ServicePlanCatalog.findOne({where:{key,ownerAdminId:root},transaction:t,lock:t.LOCK.UPDATE});
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
    await p.update(body,{transaction:t});
    if(p.autoPriority&&!p.autoFailover)throw new AppError(422,"INVALID_PLAN","Prioridade automática exige failover.");
    await audit({actor:actorOf(req),action:"network.plan.update",entityType:"service_plan",entityId:key,metadata:{fields:Object.keys(body)},transaction:t});
    return p;
  });
  invalidatePlan();invalidateServerPools();clearResolutionCache();res.json(plan);
});
router.get("/partners",validate({query:listQuery}),async(req,res)=>{
  const {page,pageSize,q,kind}=req.valid.query;
  if(!adminHasNetworkPermission(req.user,"network:partners:read") && !adminHasNetworkPermission(req.user,"network:resellers:read"))
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","Consulta não autorizada.");
  if(kind==="reseller"&&!adminHasNetworkPermission(req.user,"network:resellers:read") ||
     kind==="content"&&!adminHasNetworkPermission(req.user,"network:partners:read"))
     throw new AppError(403,"NETWORK_PERMISSION_DENIED","Consulta não autorizada.");
  const mayPartner=adminHasNetworkPermission(req.user,"network:partners:read"),
    mayReseller=adminHasNetworkPermission(req.user,"network:resellers:read");
  const types=kind === "both"?(mayPartner&&mayReseller?["both"]:[]):
    kind?[kind,...(mayPartner&&mayReseller?["both"]:[])]:[
      ...(mayPartner?["content"]:[]),...(mayReseller?["reseller"]:[]),
      ...(mayPartner&&mayReseller?["both"]:[])];
  const where={ownerAdminId:tenant(req),kind:{[Op.in]:types},status:{[Op.ne]:"deleted"}};
  if(q){const search=`%${q.replace(/[%_\\]/g,"")}%`;where[Op.or]=[{name:{[Op.iLike]:search}},{contactEmail:{[Op.iLike]:search}},{slug:{[Op.iLike]:search}}]}
  const {rows,count}=await Partner.findAndCountAll({where,attributes:["id","name","slug","kind","status","monthlyFeeCents","deviceLimit","endsAt","createdAt"],
    order:[["createdAt","DESC"]],offset:(page-1)*pageSize,limit:pageSize});
  res.json(mapPage(rows,count,{page,pageSize}));
});
router.post("/partners",validate({body:partnerBody}),async(req,res)=>{
  const b=req.valid.body, root=tenant(req), perm=b.kind==="reseller"?"network:resellers:write":"network:partners:write";
  if(!adminHasNetworkPermission(req.user,perm) || b.kind==="both"&&!adminHasNetworkPermission(req.user,"network:resellers:write"))
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para cadastrar este tipo de conta.");
  assertResourceQuota(req,b);
  let created;
  try{created=await sequelize.transaction(async transaction=>{
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtextextended(:key,0))",{replacements:{key:`network:${root}`},transaction});
    const plan=await ownedPlan(root,b.planKey,b.kind,transaction);
    if(plan.maxServers!==null && (b.dnsLimit===null || b.dnsLimit===0 || b.dnsLimit>plan.maxServers))
      throw new AppError(422,"DNS_ABOVE_PLAN","DNS não pode superar o plano autorizado.");
    if(b.kind!=="reseller"){
      const count=await Partner.count({where:{ownerAdminId:root,kind:{[Op.in]:["content","both"]},status:{[Op.ne]:"deleted"}},transaction});
      assertQuota(req,"maxPartners",count,"PARTNER_QUOTA_EXCEEDED");
    }
    if(b.kind!=="content"){
      const count=await Partner.count({where:{ownerAdminId:root,kind:{[Op.in]:["reseller","both"]},status:{[Op.ne]:"deleted"}},transaction});
      assertQuota(req,"maxResellers",count,"RESELLER_QUOTA_EXCEEDED");
    }
    const begins=new Date();if(b.endsAt<=begins)throw new AppError(422,"INVALID_PERIOD","O vencimento precisa ser futuro.");
    const p=await Partner.create({name:b.name,slug:b.slug,kind:b.kind,status:"active",ownerAdminId:root,
      contactName:b.contactName??b.portalUser.name,contactEmail:b.contactEmail??b.portalUser.email,contactPhone:b.contactPhone??null,
      startsAt:begins,endsAt:b.endsAt,billingModel:"fixed",monthlyFeeCents:b.monthlyFeeCents,
      deviceLimit:b.activationLimit,dueDay:10,graceDays:5,suspendPolicy:"auto_after_grace"},{transaction});
    await applyOwnedTerms(p,{activationLimit:b.activationLimit,dnsLimit:b.dnsLimit,monthlyFeeCents:b.monthlyFeeCents,planKey:plan.key},transaction);
    const u=await AdminUser.create({name:b.portalUser.name,email:b.portalUser.email,passwordHash:await hashPassword(b.portalUser.password),
      role:"partner",partnerId:p.id,status:"active"},{transaction});
    await audit({actor:actorOf(req),action:"network.partner.create",entityType:"partner",entityId:p.id,
      metadata:{kind:b.kind,planKey:b.planKey,userId:u.id,ownerAdminId:root},transaction});
    return p;
  });}catch(e){normalizeError(e)}
  invalidatePlan(created.id);invalidateServerPools();clearResolutionCache();clearContractAccessCache();res.status(201).json({id:created.id,name:created.name,kind:created.kind});
});
router.get("/partners/:id",validate({params:ident}),async(req,res)=>{
  const root=tenant(req),p=await ownedPartner(root,req.valid.params.id);
  const perm=p.kind==="reseller"?"network:resellers:read":"network:partners:read";
  if(!adminHasNetworkPermission(req.user,perm) || p.kind==="both"&&!adminHasNetworkPermission(req.user,"network:resellers:read"))
    throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem acesso à conta.");
  const [terms,plan,users]=await Promise.all([ContentPartnerTerms.findByPk(p.id),PartnerServicePlan.findByPk(p.id),
    adminHasNetworkPermission(req.user,"network:members:read")?
      AdminUser.findAll({where:{partnerId:p.id,role:"partner",deletedAt:null},attributes:["id","name","email","status","createdAt"]}):Promise.resolve([])]);
  res.json({partner:p,contract:terms,plan,users});
});
router.patch("/partners/:id",validate({params:ident,body:partnerChanges}),async(req,res)=>{
  const root=tenant(req),b=req.valid.body;
  assertResourceQuota(req,b);
  const updated=await sequelize.transaction(async t=>{
    const p=await ownedPartner(root,req.valid.params.id,t,true);
    const perm=p.kind==="reseller"?"network:resellers:write":"network:partners:write";
    if(!adminHasNetworkPermission(req.user,perm) || p.kind==="both"&&!adminHasNetworkPermission(req.user,"network:resellers:write"))
      throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para editar esta conta.");
    if(b.endsAt && b.endsAt<=p.startsAt)throw new AppError(422,"INVALID_PERIOD","Vencimento inválido.");
    await verifyLimitsInUse(p.id,b,t);
    // Mesmo um PATCH contendo apenas dnsLimit deve respeitar o plano já atribuído.
    // Nunca confiar que o cliente repetirá planKey em toda edição.
    if(b.planKey!==undefined || b.dnsLimit!==undefined){
      const technical=await PartnerServicePlan.findByPk(p.id,{transaction:t,lock:t.LOCK.UPDATE});
      const effectivePlanKey=b.planKey??technical?.tier;
      if(!effectivePlanKey)throw new AppError(409,"PLAN_REQUIRED","A conta precisa de um plano vigente antes de alterar DNS.");
      const plan=await ownedPlan(root,effectivePlanKey,p.kind,t);
      const effective=b.dnsLimit!==undefined ? b.dnsLimit : (technical?.maxServersOverride ?? plan.maxServers);
      if(plan.maxServers!==null && (effective===null||effective===0||effective>plan.maxServers))
        throw new AppError(422,"DNS_ABOVE_PLAN","O DNS excede o limite do plano.");
      await verifyLimitsInUse(p.id,{dnsLimit:effective},t);
    }
    const {planKey,activationLimit,dnsLimit,...fields}=b;
    if(activationLimit!==undefined)fields.deviceLimit=activationLimit;
    if(fields.monthlyFeeCents!==undefined)fields.billingModel="fixed";
    await p.update(fields,{transaction:t});
    if(planKey!==undefined || activationLimit!==undefined || dnsLimit!==undefined || b.monthlyFeeCents!==undefined)
      await applyOwnedTerms(p,{planKey,activationLimit,dnsLimit,monthlyFeeCents:b.monthlyFeeCents},t);
    await audit({actor:actorOf(req),action:"network.partner.update",entityType:"partner",entityId:p.id,
      metadata:{fields:Object.keys(b)},transaction:t});return p;
  });
  invalidatePlan(updated.id);invalidateServerPools();clearResolutionCache();clearContractAccessCache();res.json({id:updated.id,status:updated.status});
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
  body:z.object({status:z.enum(["active","disabled"])}).strict()}),async(req,res)=>{
  if(!adminHasNetworkPermission(req.user,"network:members:write"))throw new AppError(403,"NETWORK_PERMISSION_DENIED","Sem permissão para gerenciar usuários.");
  await sequelize.transaction(async t=>{
    await ownedPartner(tenant(req),req.valid.params.id,t,true);
    const u=await AdminUser.findOne({where:{id:req.valid.params.userId,partnerId:req.valid.params.id,role:"partner"},transaction:t,lock:t.LOCK.UPDATE});
    if(!u)throw new AppError(404,"NOT_FOUND","Usuário não encontrado nesta parceria.");
    await u.update({status:req.valid.body.status},{transaction:t});
    await AdminUser.increment("tokenVersion",{where:{id:u.id},transaction:t});
    await audit({actor:actorOf(req),action:"network.user.status",entityType:"admin_user",entityId:u.id,metadata:{status:req.valid.body.status},transaction:t});
  });res.json({ok:true});
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
router.get("/partners/:id/devices",requireScope("network:devices:read"),validate({params:ident,query:pagination}),async(req,res)=>{
  const p=await ownedPartner(tenant(req),req.valid.params.id);
  res.json(await listActivations({...req.valid.query,partnerId:p.id},{partnerId:p.id}));
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
