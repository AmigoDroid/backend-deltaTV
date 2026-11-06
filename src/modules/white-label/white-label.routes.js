import express, { Router } from "express";
import { createHash } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { validate, partialInput } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf, audit } from "../../shared/audit.js";
import { AppError } from "../../shared/errors.js";
import { requirePermission } from "../../middleware/authenticate.js";
import * as service from "./white-label.service.js";
import * as appearance from "./appearance.service.js";
import { generateRokuBuild } from "./roku-builder.service.js";
import { ASSET_SIZES, storeRokuAsset, listRokuAssets } from './roku-assets.js';
import { appearanceBody } from "./appearance.schema.js";
import { APPEARANCE_PRESETS } from "./appearance.presets.js";

const expressRokuRaw = express.raw({type:'image/png',limit:'3mb'});
const id = z.object({ id: z.string().uuid() });
const rokuEdition = z.object({ edition: z.enum(["economy", "dedicated"]).default("dedicated"),
  buildVersion: z.coerce.number().int().min(1).max(99999).default(1) });
const rokuAssetParams = z.object({ id: z.string().uuid(), kind: z.enum(Object.keys(ASSET_SIZES)) });
async function checkRokuAssetOwner(appId, partnerId) {
  const app = await service.getApp(appId, partnerId); // ownership before touching files
  if (partnerId && !app.appearanceEnabled)
    throw new AppError(403,'APPEARANCE_DISABLED','O Estúdio Visual não está liberado para este aplicativo.');
  if (app.status === 'archived')
    throw new AppError(409,'APP_ARCHIVED','Aplicativo arquivado.');
}
async function uploadRokuAsset(req, res, partnerId) {
  await checkRokuAssetOwner(req.valid.params.id, partnerId);
  const image = await storeRokuAsset(req.valid.params.id, req.valid.params.kind, req.body);
  await audit({actor:actorOf(req),action:'white-label.roku.asset',
    entityType:'white_label_app',entityId:req.valid.params.id,metadata:{kind:req.valid.params.kind,...image}});
  res.status(201).json({kind:req.valid.params.kind,...image});
}

// Exports are CPU-heavy: avoid multiple simultaneous compressions by the same actor.
const rokuLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false,
  keyGenerator: req => `roku-export:${req.user?.id || req.ip}`, validate: false });
async function sendRokuZip(req, res, partnerId) {
  const built = await generateRokuBuild(req.valid.params.id, partnerId, req.valid.query.edition, actorOf(req), req.valid.query.buildVersion);
  res.set({ "Content-Type": "application/zip", "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff", "Content-Disposition": `attachment; filename="${built.filename}"`,
    "Content-Length": String(built.buffer.length) });
  res.end(built.buffer);
}

const serverIds = z.object({ id: z.string().uuid(), serverId: z.string().uuid() });
const activationIds = z.object({ id: z.string().uuid(), activationId: z.string().uuid() });
const listQuery = z.object({ ...pageQuery, q: z.string().trim().max(70).optional() });
const httpUrl = z.string().trim().url().max(500).refine(raw => {
  try { return ["https:", "http:"].includes(new URL(raw).protocol); } catch { return false; }
}, "Informe um endereço HTTP(S) válido.");
const optionalUrl = z.union([httpUrl, z.literal("")]).nullable().optional();
const appBaseBody = z.object({
  partnerId: z.string().uuid(), appKey: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
  name: z.string().trim().min(2).max(120), logoUrl: optionalUrl, downloadUrl: optionalUrl,
  status: z.enum(["draft", "active", "suspended"]).default("draft"),
  planType: z.enum(["limited", "unlimited"]), activationLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  monthlyFeeCents: z.number().int().min(0).max(100_000_000),
  paidThrough: z.iso.date().nullable().optional(), notes: z.string().max(2000).nullable().optional(),
}).strict();
// Zod 4 não permite .omit() sobre objetos com refinamentos. Derivamos os
// schemas de um objeto base e só depois aplicamos a regra de criação.
const createBody = appBaseBody.superRefine((value, context) => {
  if (value.planType === "limited" && !value.activationLimit)
    context.addIssue({ code: "custom", path: ["activationLimit"], message: "Informe a quantidade do plano limitado." });
});
// No PATCH, omissões não podem aplicar defaults de criação (ex.: status: draft).
// A validação de limite final permanece em service.updateApp(), que considera
// o plano e a quantidade já persistidos no banco.
const updateBody = partialInput(appBaseBody.omit({ partnerId: true, appKey: true })).strict();
const serverBody = z.object({
  name: z.string().trim().min(2).max(120), baseUrl: httpUrl,
  status: z.enum(["active", "disabled"]).default("active"), priority: z.number().int().min(-1000).max(1000).default(0),
}).strict();
// Também evita resetar status/priority em atualizações parciais de servidor.
const serverUpdate = partialInput(serverBody).strict();
const paymentBody = z.object({
  reference: z.string().trim().min(3).max(120), months: z.number().int().min(1).max(24),
  amountCents: z.number().int().min(0).max(100_000_000), notes: z.string().max(500).optional(),
}).strict();

export const adminRouter = Router();
// Provisionamento e preços: exclusivos do superadmin. Operadores não podem alterar o contrato comercial.
adminRouter.use((req, res, next) => requirePermission("white-label:manage")(req, res, next));
adminRouter.get("/", validate({ query: listQuery }), async (req, res) => res.json(await service.listApps(req.valid.query)));
adminRouter.post("/", validate({ body: createBody }), async (req, res) =>
  res.status(201).json(await service.createApp(req.valid.body, actorOf(req))));
adminRouter.get("/:id", validate({ params: id }), async (req, res) => res.json(await service.getApp(req.valid.params.id, null)));
adminRouter.patch("/:id", validate({ params: id, body: updateBody }), async (req, res) =>
  res.json(await service.updateApp(req.valid.params.id, req.valid.body, actorOf(req))));
adminRouter.post("/:id/payments", validate({ params: id, body: paymentBody }), async (req, res) =>
  res.json(await service.recordPayment(req.valid.params.id, req.valid.body, actorOf(req))));
adminRouter.get("/:id/payments", validate({ params: id }), async (req, res) =>
  res.json({ data: await service.listPayments(req.valid.params.id, null) }));
adminRouter.get("/:id/servers", validate({ params: id }), async (req, res) =>
  res.json({ data: await service.listServers(req.valid.params.id, null) }));
adminRouter.post("/:id/servers", validate({ params: id, body: serverBody }), async (req, res) =>
  res.status(201).json(await service.addServer(req.valid.params.id, null, req.valid.body, actorOf(req))));
adminRouter.patch("/:id/servers/:serverId", validate({ params: serverIds, body: serverUpdate }), async (req, res) =>
  res.json(await service.editServer(req.valid.params.id, req.valid.params.serverId, null, req.valid.body, actorOf(req))));
adminRouter.delete("/:id/servers/:serverId", validate({ params: serverIds }), async (req, res) => {
  await service.removeServer(req.valid.params.id, req.valid.params.serverId, null, actorOf(req)); res.status(204).end();
});
// Visual Studio access control is exclusive to superadmin; no partner-controlled bypass.
adminRouter.patch("/:id/appearance-access", validate({ params: id,
  body: z.object({ enabled: z.boolean() }).strict() }), async (req, res) =>
  res.json(await appearance.setAppearanceAccess(req.valid.params.id, req.valid.body.enabled, actorOf(req))));
adminRouter.get("/:id/appearance", validate({ params: id }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.getAppearance(req.valid.params.id)));
// The Superadmin can customize the look before exporting a separately signed channel.
adminRouter.put("/:id/appearance/draft", validate({ params: id, body: appearanceBody }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.saveAppearance(req.valid.params.id, null, req.valid.body, actorOf(req))));
adminRouter.post("/:id/appearance/publish", validate({ params: id }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.publishAppearance(req.valid.params.id, null, actorOf(req))));

adminRouter.get('/:id/roku-assets', validate({params:id}), async (req,res)=>{
  await checkRokuAssetOwner(req.valid.params.id,null);
  res.set('Cache-Control','no-store').json({assets:await listRokuAssets(req.valid.params.id)});
});
adminRouter.put('/:id/roku-assets/:kind', expressRokuRaw, validate({params:rokuAssetParams}), async(req,res)=>
  uploadRokuAsset(req,res,null));
adminRouter.get("/:id/roku-export", rokuLimiter, validate({ params: id, query: rokuEdition }), async (req, res) =>
  sendRokuZip(req, res, null));
adminRouter.get("/:id/activations", validate({ params: id, query: z.object(pageQuery) }), async (req, res) =>
  res.json(await service.listActivations(req.valid.params.id, null, req.valid.query)));
for (const action of ["revoke", "restore"]) {
  adminRouter.post(`/:id/activations/:activationId/${action}`, validate({ params: activationIds }), async (req, res) =>
    res.json(await service.changeActivation(req.valid.params.id, req.valid.params.activationId, null, action, actorOf(req))));
}

export const partnerRouter = Router();
const owned = (req) => req.user.partnerId; // nunca aceitar ownerPartnerId no corpo/URL da revenda.
partnerRouter.get("/", validate({ query: listQuery }), async (req, res) =>
  res.json(await service.listApps({ ...req.valid.query, partnerId: owned(req) })));
partnerRouter.get("/:id", validate({ params: id }), async (req, res) =>
  res.json(await service.getApp(req.valid.params.id, owned(req))));
partnerRouter.get("/:id/servers", validate({ params: id }), async (req, res) =>
  res.json({ data: await service.listServers(req.valid.params.id, owned(req)) }));
partnerRouter.post("/:id/servers", validate({ params: id, body: serverBody }), async (req, res) =>
  res.status(201).json(await service.addServer(req.valid.params.id, owned(req), req.valid.body, actorOf(req))));
partnerRouter.patch("/:id/servers/:serverId", validate({ params: serverIds, body: serverUpdate }), async (req, res) =>
  res.json(await service.editServer(req.valid.params.id, req.valid.params.serverId, owned(req), req.valid.body, actorOf(req))));
partnerRouter.delete("/:id/servers/:serverId", validate({ params: serverIds }), async (req, res) => {
  await service.removeServer(req.valid.params.id, req.valid.params.serverId, owned(req), actorOf(req)); res.status(204).end();
});
// Partner can only edit apps belonging to their own authenticated partnership.
partnerRouter.get("/appearance/eligible", async (req, res) =>
  res.json({ data: await appearance.listEditableAppearances(owned(req)) }));
partnerRouter.get("/appearance/presets", (_req, res) => res.json({ presets: APPEARANCE_PRESETS }));
partnerRouter.get("/:id/appearance", validate({ params: id }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.getAppearance(req.valid.params.id, owned(req))));
partnerRouter.put("/:id/appearance/draft", validate({ params: id, body: appearanceBody }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.saveAppearance(req.valid.params.id, owned(req), req.valid.body, actorOf(req))));
partnerRouter.post("/:id/appearance/publish", validate({ params: id }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await appearance.publishAppearance(req.valid.params.id, owned(req), actorOf(req))));
partnerRouter.get('/:id/roku-assets', validate({params:id}), async (req,res)=>{
  await checkRokuAssetOwner(req.valid.params.id,owned(req));
  res.set('Cache-Control','no-store').json({assets:await listRokuAssets(req.valid.params.id)});
});
partnerRouter.put('/:id/roku-assets/:kind', expressRokuRaw, validate({params:rokuAssetParams}), async(req,res)=>
  uploadRokuAsset(req,res,owned(req)));
partnerRouter.get("/:id/roku-export", rokuLimiter, validate({ params: id, query: rokuEdition }), async (req, res) =>
  sendRokuZip(req, res, owned(req)));
partnerRouter.get("/:id/activations", validate({ params: id, query: z.object(pageQuery) }), async (req, res) =>
  res.json(await service.listActivations(req.valid.params.id, owned(req), req.valid.query)));
for (const action of ["revoke", "restore"]) {
  partnerRouter.post(`/:id/activations/:activationId/${action}`, validate({ params: activationIds }), async (req, res) =>
    res.json(await service.changeActivation(req.valid.params.id, req.valid.params.activationId, owned(req), action, actorOf(req))));
}
partnerRouter.get("/:id/payments", validate({ params: id }), async (req, res) =>
  res.json({ data: await service.listPayments(req.valid.params.id, owned(req)) }));

const infoLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });
// Published palettes are public, tiny and frequently polled by fleets of TVs sharing a NAT IP.
const appearanceLimiter = rateLimit({ windowMs: 60_000, limit: 1500, standardHeaders: "draft-7", legacyHeaders: false });
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 120,
  standardHeaders: "draft-7", legacyHeaders: false, message: { code: "RATE_LIMIT", message: "Muitas tentativas. Aguarde um minuto." } });
// A segunda barreira impede tentativas repetidas da mesma instalação sem
// bloquear uma rede residencial ou empresarial com muitos dispositivos Roku.
const activationDeviceLimiter = rateLimit({ windowMs: 60_000, limit: 5,
  standardHeaders: 'draft-7', legacyHeaders: false, validate: false,
  keyGenerator: req => 'wl-activate:' + createHash('sha256').update(
    `${req.ip}|${req.params?.appKey || ''}|${req.body?.installationId || ''}`).digest('hex'),
  message: { code: 'RATE_LIMIT', message: 'Aguarde um minuto antes de tentar novamente neste aparelho.' } });
// Sessões ativas são limitadas por token, não pelo IP público compartilhado de TVs.
const sessionLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false,
  keyGenerator: req => "wl-session:" + createHash("sha256").update(String(req.body?.sessionToken || req.ip)).digest("hex"),
  validate: false,
  message: { code: "RATE_LIMIT", message: "Muitas verificações desta sessão. Aguarde." } });
const publicKey = z.object({ appKey: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/) });
const activationBody = z.object({
  installationId: z.string().regex(/^[a-zA-Z0-9_-]{16,128}$/),
  platform: z.enum(["roku", "androidtv", "samsung", "lg", "web", "other"]),
  username: z.string().min(1).max(128), password: z.string().min(1).max(256),
}).strict();
export const publicRouter = Router();
// Anonymous player receives only the last published config, never the draft.
publicRouter.get("/:appKey/appearance", appearanceLimiter, validate({ params: publicKey }), async (req, res) =>
  res.set("Cache-Control", "public, max-age=120").json(await appearance.publicAppearance(req.valid.params.appKey)));
publicRouter.get("/:appKey", infoLimiter, validate({ params: publicKey }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await service.publicAppInfo(req.valid.params.appKey)));
publicRouter.post("/:appKey/activate", publicLimiter, activationDeviceLimiter, validate({ params: publicKey, body: activationBody }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await service.activateByXtream(req.valid.params.appKey, req.valid.body)));

publicRouter.post("/:appKey/session", sessionLimiter,
  validate({ params: publicKey, body: z.object({ sessionToken: z.string().min(40).max(4096) }).strict() }),
  async (req, res) => res.set("Cache-Control", "no-store")
    .json(await service.validateAppSession(req.valid.params.appKey, req.valid.body.sessionToken)));
