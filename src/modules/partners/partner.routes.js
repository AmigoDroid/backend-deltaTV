import { livePartnerIds } from "../../realtime/socket.js";
import { Router } from "express";
import { z } from "zod";
import { validate, partialInput } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission, can } from "../../middleware/authenticate.js";
import { generateInvoice } from "../billing/billing.service.js";
import { listActivations } from "../devices/device.service.js";
import * as svc from "./partner.service.js";
import * as providers from "../providers/provider.service.js";
import * as stock from "../stock/stock.service.js";
import { DEFAULT_TEMPLATE } from "../providers/playlist-url.js";
import { codeCheckLimiter } from "../../middleware/security.js";
import * as commerce from "../content-commerce/commerce.service.js";
import {getServicePlan,updateServicePlan} from "../service-plans/plan.service.js";
import { contractOverview } from "./contract-overview.service.js";

import { partnerDeletionPreview, deletePartnerAsSuper } from "../admin-deletion.service.js";
import * as preReg from "./partner-invite.service.js";

import { setCodeServers, listCodeServerIds, invalidateServerPools } from "../provider-monitor/code-pool.service.js";
import { PartnerCode, Partner, sequelize } from "../../db/models/index.js";
import { audit } from "../../shared/audit.js";
import { AppError, notFound } from "../../shared/errors.js";
const router = Router();
const id = z.object({ id: z.string().uuid() });
const cents = z.number().int().min(0).max(100_000_000);

const commercial = z.object({
  name: z.string().trim().min(2).max(160),
  contactName: z.string().max(160).nullable().optional(),
  contactEmail: z.string().email().max(200).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  billingModel: z.enum(["none", "fixed", "per_device", "tiered"]), // none = sem mensalidade
  monthlyFeeCents: cents.optional(), perDeviceCents: cents.optional(), minFeeCents: cents.optional(),
  tiers: z.array(z.object({ upTo: z.number().int().min(1).max(2147483647).nullable(), amountCents: cents })).max(20).optional(),
  deviceLimit: z.number().int().min(0).max(2147483647).nullable().optional(),
  dueDay: z.number().int().min(1).max(28).optional(),
  graceDays: z.number().int().min(0).max(90).optional(),
  suspendPolicy: z.enum(["auto_after_grace", "manual"]).optional(),
  // content (padrão) | reseller | both. Só quem é reseller/both edita dispositivos por MAC no painel do revendedor.
  kind: z.enum(["content", "reseller", "both"]).optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const createBody = commercial.extend({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, "Use letras minúsculas, números e hífens"),
  startsAt: z.coerce.date(), endsAt: z.coerce.date(),
  portalUser: z.object({ name: z.string().min(2).max(160), email: z.string().email().max(200), password: z.string().min(12).max(128) }).optional(),
}).refine((v) => v.endsAt > v.startsAt, { message: "O término deve ser posterior ao início", path: ["endsAt"] });
const reason = z.object({ reason: z.string().trim().min(3).max(500).optional() });

router.get("/presence/live", requirePermission("partners:read"), (_req, res) => {
  const ids = livePartnerIds();
  res.set("Cache-Control", "no-store");
  res.json({ onlinePartnerIds: ids, onlineCount: ids.length, source: "websocket" });
});

router.get(
  "/", requirePermission("partners:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(100).optional(), status: z.enum(["pending", "active", "expired", "suspended", "blocked", "cancelled"]).optional(), kind: z.enum(["content", "reseller"]).optional() }) }),
  async (req, res) => res.json(await svc.listPartners(req.valid.query)),
);
// Central comercial do Superadmin: paginação no banco e preço real negociado por parceiro.
router.get("/contract-overview", requirePermission("override"), validate({ query: z.object({
  ...pageQuery, q: z.string().max(100).optional(), kind: z.enum(["content", "reseller"]).optional(),
}) }), async (req, res) => res.set("Cache-Control", "no-store").json(await contractOverview(req.valid.query)));
router.post("/", requirePermission("partners:write"), validate({ body: createBody }), async (req, res) => {
  const p = await svc.createPartner(req.valid.body, actorOf(req));
  res.status(201).json(await svc.getPartner(p.id));
});
// Pré-cadastro por convite: registro independente, sem gerar parceiro antes da confirmação por e-mail.
const preRegId = z.object({ preRegId: z.string().uuid() });
router.get("/pre-registrations", requirePermission("partners:read"), validate({ query: z.object({
  ...pageQuery, view: z.enum(["pending", "history"]).default("pending"),
}) }), async (req, res) => res.set("Cache-Control", "no-store").json(await preReg.listPreRegistrations(req.valid.query)));
router.post("/pre-registrations/:preRegId/finish", requirePermission("partners:write"), validate({ params: preRegId }), async (req, res) =>
  res.json(await preReg.finishPreRegistration(req.valid.params.preRegId, actorOf(req))));
router.post("/pre-registrations", requirePermission("partners:write"), validate({ body: z.object({
  name: z.string().trim().min(2).max(160), email: z.string().trim().email().max(200), sendEmail: z.boolean().default(false),
}).strict() }), async (req, res) => res.status(201).json(await preReg.createPreRegistration(req.valid.body, actorOf(req))));
router.post("/pre-registrations/:preRegId/send", requirePermission("partners:write"), validate({ params: preRegId }), async (req, res) =>
  res.json(await preReg.sendPreRegistrationInvite(req.valid.params.preRegId, actorOf(req))));
router.post("/pre-registrations/:preRegId/cancel", requirePermission("partners:write"), validate({ params: preRegId }), async (req, res) =>
  res.json(await preReg.cancelPreRegistration(req.valid.params.preRegId, actorOf(req))));
router.get("/codes/check", requirePermission("partners:read"), codeCheckLimiter, validate({ query: z.object({ code: z.string().max(40) }) }), async (req, res) => res.json(await svc.checkCode(req.valid.query.code)));
router.get("/:id/deletion-preview", requirePermission("override"), validate({ params: id }), async (req, res) => res.set("Cache-Control", "no-store").json(await partnerDeletionPreview(req.valid.params.id, actorOf(req))));
router.delete("/:id", requirePermission("override"), validate({ params: id, body: z.object({
  confirmation: z.string().trim().min(1).max(160).optional(),
  confirmSlug: z.string().trim().min(1).max(160).optional(), // compatível com painel antigo
  deleteClients: z.boolean(), deleteDevices: z.boolean(),
  reason: z.string().trim().min(8).max(400),
}).strict().refine((value) => Boolean(value.confirmation || value.confirmSlug), {
  message: "Digite o nome ou identificador da parceria para confirmar.", path: ["confirmation"],
}) }), async (req, res) => res.json(await deletePartnerAsSuper(req.valid.params.id, req.valid.body, actorOf(req))));
router.get("/:id", requirePermission("partners:read"), validate({ params: id }), async (req, res) => res.json(await svc.getPartner(req.valid.params.id)));
// Capacidade técnica por plano; condições financeiras continuam independentes.
router.get("/:id/service-plan",requirePermission("partners:read"),validate({params:id}),async(req,res)=>
  res.set("Cache-Control","no-store").json(await getServicePlan(req.valid.params.id)));
const nullableBool=z.boolean().nullable();
router.put("/:id/service-plan",requirePermission("partners:write"),validate({params:id,body:z.object({
  tier:z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  // null = herdar do plano; 0 = sem limite; número positivo = limite negociado.
  maxServersOverride:z.number().int().min(0).max(2147483647).nullable().optional(),
  autoFailoverOverride:nullableBool.optional(),autoPriorityOverride:nullableBool.optional(),
  emailAlertsOverride:nullableBool.optional(),detailedHistoryOverride:nullableBool.optional(),
}).strict()}),async(req,res)=>res.json(await updateServicePlan(req.valid.params.id,req.valid.body,actorOf(req))));

// Condições comerciais exclusivas do parceiro de conteúdo. Nunca permitir que o parceiro altere o próprio contrato.
router.get("/:id/commercial",requirePermission("partners:read"),validate({params:id}),async(req,res)=>res.set("Cache-Control","no-store").json(await commerce.dashboard(req.valid.params.id)));
router.put("/:id/commercial",requirePermission("billing:write"),validate({params:id,body:z.object({
  mode:z.enum(["legacy","credits","fixed_unlimited","fixed_limited"]),
  fixedFeeCents:z.number().int().min(0).max(100000000),
  activationLimit:z.number().int().min(0).max(10000000).nullable(),
  licensePolicy:z.enum(["standard","partner_only"]),
  creditsPerActivation:z.number().int().min(1).max(100),
  autoPriority:z.boolean(),
  allowWebIssuance:z.boolean(),
})}),async(req,res)=>res.json(await commerce.saveTerms(req.valid.params.id,req.valid.body,actorOf(req))));
router.post("/:id/commercial/credits",requirePermission("billing:write"),validate({params:id,body:z.object({delta:z.number().int().min(-1000000).max(1000000).refine(n=>n!==0),note:z.string().trim().min(3).max(300)})}),
  async(req,res)=>res.json(await commerce.adminAdjust(req.valid.params.id,req.valid.body,actorOf(req))));

// O admin também corrige identificador (slug) e vigência; o endpoint /renew continua existindo para o caso comum.
const identity = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, "Use letras minúsculas, números e hífens").optional(),
  startsAt: z.coerce.date().optional(), endsAt: z.coerce.date().optional(),
});
router.patch("/:id", requirePermission("partners:write"), validate({ params: id, body: commercial.partial().merge(identity).refine((v) => !v.startsAt || !v.endsAt || v.endsAt > v.startsAt, { message: "O término deve ser posterior ao início", path: ["endsAt"] }) }), async (req, res) => {
  await svc.updatePartner(req.valid.params.id, req.valid.body, actorOf(req));
  res.json(await svc.getPartner(req.valid.params.id));
});
router.post("/:id/renew", requirePermission("partners:write"), validate({ params: id, body: z.object({ endsAt: z.coerce.date() }) }), async (req, res) => {
  await svc.renewPartner(req.valid.params.id, req.valid.body, actorOf(req));
  res.json(await svc.getPartner(req.valid.params.id));
});
for (const action of ["suspend", "block", "reactivate", "cancel"]) {
  router.post(`/:id/${action}`, requirePermission("partners:write"), validate({ params: id, body: reason }), async (req, res) => {
    await svc.changePartnerStatus(req.valid.params.id, action, { ...req.valid.body, force: can(req.user.role, "override") }, actorOf(req));
    res.json(await svc.getPartner(req.valid.params.id));
  });
}

// `code` opcional: informado = código escolhido (validado e único); omitido = gerado automaticamente.
const codeBody = z.object({
  code: z.string().trim().min(4).max(12).optional(),
  label: z.string().max(120).optional(),
  maxActivations: z.number().int().min(1).max(2147483647).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  // Servidor do parceiro para o qual o código aponta. Omitido: usa o único servidor do parceiro (se houver só um).
  providerId: z.string().uuid().nullable().optional(),
  // Duração (meses) da licença do ESTOQUE do revendedor que o código consome ao ativar um dispositivo.
  licenseMonths: z.number().int().min(1).max(120).nullable().optional(),
});
const codeUpdateBody = codeBody.omit({ code: true }).partial().extend({ allowWebIssuance: z.boolean().optional() });
const providerBody = z.object({
  name: z.string().trim().min(2).max(120),
  baseUrl: z.string().trim().max(500),
  playlistTemplate: z.string().max(500).default(DEFAULT_TEMPLATE),
  deliveryMode: z.enum(["redirect", "proxy"]).default("redirect"),
  priority: z.number().int().min(0).max(1000).default(0),
  status: z.enum(["active", "disabled"]).default("active"),
});
const prov = z.object({ id: z.string().uuid(), providerId: z.string().uuid() });
router.get("/:id/codes", requirePermission("partners:read"), validate({ params: id }), async (req, res) => res.json({ data: await svc.listCodes(req.valid.params.id) }));
router.post("/:id/codes", requirePermission("partners:write"), validate({ params: id, body: codeBody }), async (req, res) =>
  res.status(201).json(await svc.createCode(req.valid.params.id, req.valid.body, actorOf(req))));
router.patch("/:id/codes/:codeId", requirePermission("partners:write"), validate({ params: z.object({ id: z.string().uuid(), codeId: z.string().uuid() }), body: codeUpdateBody }), async (req, res) =>
  res.json(await svc.updateCode(req.valid.params.id, req.valid.params.codeId, req.valid.body, actorOf(req))));
router.post("/:id/codes/:codeId/revoke", requirePermission("partners:write"), validate({ params: z.object({ id: z.string().uuid(), codeId: z.string().uuid() }) }), async (req, res) => {
  await svc.revokeCode(req.valid.params.id, req.valid.params.codeId, actorOf(req));
  res.status(204).end();
});

router.get("/:id/providers", requirePermission("partners:read"), validate({ params: id }), async (req, res) => res.json({ data: await providers.listProviders(req.valid.params.id) }));
router.post("/:id/providers", requirePermission("partners:write"), validate({ params: id, body: providerBody }), async (req, res) =>
  res.status(201).json(await providers.createProvider(req.valid.params.id, req.valid.body, actorOf(req))));
router.patch("/:id/providers/:providerId", requirePermission("partners:write"), validate({ params: prov, body: partialInput(providerBody) }), async (req, res) =>
  res.json(await providers.updateProvider(req.valid.params.id, req.valid.params.providerId, req.valid.body, actorOf(req))));
router.delete("/:id/providers/:providerId", requirePermission("partners:write"), validate({ params: prov }), async (req, res) => {
  await providers.deleteProvider(req.valid.params.id, req.valid.params.providerId, actorOf(req));
  res.status(204).end();
});

// Estoque de licenças do revendedor (lançamento manual pelo admin).
// Duração padrão: 1 mês (quando o campo é omitido).
const stockMonths = z.number().int().min(1).max(120).default(1);
router.get("/:id/stock", requirePermission("partners:read"), validate({ params: id, query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.json(await stock.stockOf(req.valid.params.id, req.valid.query)));
router.post("/:id/stock/grant", requirePermission("partners:write"),
  validate({ params: id, body: z.object({ months: stockMonths, quantity: z.number().int().min(1).max(10000), unitPriceCents: cents.optional(), note: z.string().trim().max(500).optional() }) }),
  async (req, res) => res.status(201).json(await stock.grantStock(req.valid.params.id, req.valid.body, actorOf(req))));
router.post("/:id/stock/adjust", requirePermission("partners:write"),
  validate({ params: id, body: z.object({ months: stockMonths, delta: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, "Informe uma quantidade diferente de zero."), note: z.string().trim().min(3).max(500) }) }),
  async (req, res) => res.json(await stock.adjustStock(req.valid.params.id, req.valid.body, actorOf(req))));

// Operação bilateral exclusiva do superadmin: transferência sem precisar entrar no portal do revendedor.
router.post("/stock/transfer-admin", requirePermission("override"),
  validate({ body: z.object({ fromPartnerId: z.string().uuid(), toPartnerId: z.string().uuid(),
    months: z.number().int().min(1).max(120), quantity: z.number().int().min(1).max(10000),
    reason: z.string().trim().min(5).max(500) }) }),
  async (req, res) => res.json(await stock.adminTransferStock(req.valid.body, actorOf(req))));

router.get(
  "/:id/devices", requirePermission("devices:read"),
  validate({ params: id, query: z.object({ ...pageQuery, q: z.string().max(40).optional(), status: z.enum(["active", "blocked", "revoked"]).optional() }) }),
  async (req, res) => res.json(await listActivations({ ...req.valid.query, partnerId: req.valid.params.id })),
);

router.post("/:id/invoices", requirePermission("billing:write"), validate({ params: id, body: z.object({ competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) }), async (req, res) => {
  const r = await generateInvoice(req.valid.params.id, req.valid.body.competence, actorOf(req));
  res.status(r.created ? 201 : 200).json(r);
});

const codeParams = z.object({ id: z.string().uuid(), codeId: z.string().uuid() });
router.get("/:id/codes/:codeId/management", requirePermission("override"), validate({params:codeParams}), async(req,res)=>{
 const {id,codeId}=req.valid.params;
 const code=await PartnerCode.findOne({where:{id:codeId,partnerId:id}});
 if(!code)throw notFound("Código");
 const [pools,balances]=await Promise.all([listCodeServerIds([codeId]),commerce.balancesForCodes([codeId])]);
 res.set("Cache-Control","no-store").json({serverIds:pools.get(codeId)||(code.providerId?[code.providerId]:[]),credits:balances.get(codeId)||{allocated:0,spent:0,available:0}});
});
router.put("/:id/codes/:codeId/servers", requirePermission("override"), validate({params:codeParams,body:z.object({serverIds:z.array(z.string().uuid()).min(1)})}),async(req,res)=>res.json(await setCodeServers(req.valid.params.id,req.valid.params.codeId,req.valid.body.serverIds,actorOf(req))));
router.post("/:id/codes/:codeId/credits", requirePermission("override"), validate({params:codeParams,body:z.object({quantity:z.number().int().min(-100000).max(100000).refine(n=>n!==0)})}),async(req,res)=>res.json(await commerce.allocate(req.valid.params.id,req.valid.params.codeId,req.valid.body,actorOf(req))));
router.post("/:id/codes/:codeId/restore",requirePermission("override"),validate({params:codeParams}),async(req,res)=>{
 const {id,codeId}=req.valid.params;
 await sequelize.transaction(async t=>{
 const partner=await Partner.findByPk(id,{transaction:t,lock:t.LOCK.UPDATE});
 if(!partner||partner.status!=="active")throw new AppError(409,"PARTNER_INACTIVE","Ative a parceria antes de restaurar o código.");
 const code=await PartnerCode.findOne({where:{id:codeId,partnerId:id},transaction:t,lock:t.LOCK.UPDATE});
 if(!code)throw notFound("Código");
 if(code.expiresAt&&new Date(code.expiresAt)<=new Date())throw new AppError(409,"CODE_EXPIRED","Altere o vencimento antes de restaurar.");
 await code.update({status:"active"},{transaction:t});
 await audit({actor:actorOf(req),action:"partner.code.restore",entityType:"partner_code",entityId:codeId,transaction:t});
 });invalidateServerPools(codeId);res.json({ok:true});
});
export default router;
