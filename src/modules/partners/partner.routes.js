import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { generateInvoice } from "../billing/billing.service.js";
import { listActivations } from "../devices/device.service.js";
import * as svc from "./partner.service.js";
import * as providers from "../providers/provider.service.js";
import { DEFAULT_TEMPLATE } from "../providers/playlist-url.js";
import { codeCheckLimiter } from "../../middleware/security.js";

const router = Router();
const id = z.object({ id: z.string().uuid() });
const cents = z.number().int().min(0).max(100_000_000);

const commercial = z.object({
  name: z.string().trim().min(2).max(160),
  contactName: z.string().max(160).nullable().optional(),
  contactEmail: z.string().email().max(200).nullable().optional(),
  contactPhone: z.string().max(40).nullable().optional(),
  billingModel: z.enum(["fixed", "per_device", "tiered"]),
  monthlyFeeCents: cents.optional(), perDeviceCents: cents.optional(), minFeeCents: cents.optional(),
  tiers: z.array(z.object({ upTo: z.number().int().min(1).nullable(), amountCents: cents })).max(20).optional(),
  deviceLimit: z.number().int().min(0).nullable().optional(),
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

router.get(
  "/", requirePermission("partners:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(100).optional(), status: z.enum(["active", "expired", "suspended", "blocked", "cancelled"]).optional() }) }),
  async (req, res) => res.json(await svc.listPartners(req.valid.query)),
);
router.post("/", requirePermission("partners:write"), validate({ body: createBody }), async (req, res) => {
  const p = await svc.createPartner(req.valid.body, actorOf(req));
  res.status(201).json(await svc.getPartner(p.id));
});
router.get("/codes/check", requirePermission("partners:read"), codeCheckLimiter, validate({ query: z.object({ code: z.string().max(40) }) }), async (req, res) => res.json(await svc.checkCode(req.valid.query.code)));
router.get("/:id", requirePermission("partners:read"), validate({ params: id }), async (req, res) => res.json(await svc.getPartner(req.valid.params.id)));
router.patch("/:id", requirePermission("partners:write"), validate({ params: id, body: commercial.partial() }), async (req, res) => {
  await svc.updatePartner(req.valid.params.id, req.valid.body, actorOf(req));
  res.json(await svc.getPartner(req.valid.params.id));
});
router.post("/:id/renew", requirePermission("partners:write"), validate({ params: id, body: z.object({ endsAt: z.coerce.date() }) }), async (req, res) => {
  await svc.renewPartner(req.valid.params.id, req.valid.body, actorOf(req));
  res.json(await svc.getPartner(req.valid.params.id));
});
for (const action of ["suspend", "block", "reactivate", "cancel"]) {
  router.post(`/:id/${action}`, requirePermission("partners:write"), validate({ params: id, body: reason }), async (req, res) => {
    await svc.changePartnerStatus(req.valid.params.id, action, req.valid.body, actorOf(req));
    res.json(await svc.getPartner(req.valid.params.id));
  });
}

// `code` opcional: informado = código escolhido (validado e único); omitido = gerado automaticamente.
const codeBody = z.object({
  code: z.string().trim().min(4).max(12).optional(),
  label: z.string().max(120).optional(),
  maxActivations: z.number().int().min(1).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  // Servidor do parceiro para o qual o código aponta. Omitido: usa o único servidor do parceiro (se houver só um).
  providerId: z.string().uuid().nullable().optional(),
});
const codeUpdateBody = codeBody.omit({ code: true }).partial();
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
router.patch("/:id/providers/:providerId", requirePermission("partners:write"), validate({ params: prov, body: providerBody.partial() }), async (req, res) =>
  res.json(await providers.updateProvider(req.valid.params.id, req.valid.params.providerId, req.valid.body, actorOf(req))));
router.delete("/:id/providers/:providerId", requirePermission("partners:write"), validate({ params: prov }), async (req, res) => {
  await providers.deleteProvider(req.valid.params.id, req.valid.params.providerId, actorOf(req));
  res.status(204).end();
});

router.get(
  "/:id/devices", requirePermission("devices:read"),
  validate({ params: id, query: z.object({ ...pageQuery, q: z.string().max(40).optional(), status: z.enum(["active", "blocked", "revoked"]).optional() }) }),
  async (req, res) => res.json(await listActivations({ ...req.valid.query, partnerId: req.valid.params.id })),
);

router.post("/:id/invoices", requirePermission("billing:write"), validate({ params: id, body: z.object({ competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) }), async (req, res) => {
  const r = await generateInvoice(req.valid.params.id, req.valid.body.competence, actorOf(req));
  res.status(r.created ? 201 : 200).json(r);
});

export default router;
