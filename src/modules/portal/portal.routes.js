import { Router } from "express";
import { z } from "zod";
import { sequelize, Partner } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/audit.js";
import { authenticate, requirePartnerRole } from "../../middleware/authenticate.js";
import * as devices from "../devices/device.service.js";
import * as partners from "../partners/partner.service.js";
import { listInvoices } from "../billing/billing.service.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { listProviders } from "../providers/provider.service.js";
import { codeCheckLimiter, macLookupLimiter, macWriteLimiter, stockLookupLimiter, stockWriteLimiter } from "../../middleware/security.js";
import * as stock from "../stock/stock.service.js";
import * as reseller from "../devices/reseller-devices.service.js";
import { isPendingSignup } from "../partners/reseller-signup.service.js";
import { configurationSchema } from "../devices/device-config.schema.js";

/**
 * Portal do parceiro (/api/v1/partner). ISOLAMENTO: o partnerId vem EXCLUSIVAMENTE do token do usuário
 * (req.user.partnerId). Nenhuma rota aceita partnerId do cliente; ids de outros parceiros resultam em 404.
 */
const router = Router();
router.use(authenticate, requirePartnerRole);
const scope = (req) => ({ partnerId: req.user.partnerId });
const id = z.object({ id: z.string().uuid() });

router.get("/me", async (req, res) => {
  const p = await Partner.findByPk(req.user.partnerId, {
    attributes: { include: [[sequelize.literal(`(SELECT count(*) FROM activations a WHERE a.partner_id = "Partner".id AND a.status <> 'revoked')`), "deviceCount"]] },
  });
  if (!p) throw notFound("Parceiro");
  res.json({
    id: p.id, name: p.name, slug: p.slug, kind: p.kind, status: p.status, effectiveStatus: effectivePartnerStatus(p),
    pendingApproval: isPendingSignup(p), statusReason: p.status === "active" ? null : p.statusReason,
    startsAt: p.startsAt, endsAt: p.endsAt, deviceLimit: p.deviceLimit, deviceCount: Number(p.get("deviceCount")),
    billingModel: p.billingModel, dueDay: p.dueDay, graceDays: p.graceDays,
  });
});

router.get("/devices", validate({ query: z.object({ ...pageQuery, q: z.string().max(40).optional(), status: z.enum(["active", "blocked", "revoked"]).optional() }) }), async (req, res) =>
  res.json(await devices.listActivations(req.valid.query, scope(req))));
router.get("/devices/:id", validate({ params: id }), async (req, res) => res.json(await devices.getActivation(req.valid.params.id, scope(req))));
for (const action of ["block", "unblock", "revoke"]) {
  router.post(`/devices/:id/${action}`, validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500).optional() }) }), async (req, res) => {
    await devices.changeActivation(req.valid.params.id, action, { reason: req.valid.body.reason, actor: actorOf(req), scope: scope(req), blockedBy: "partner" });
    res.json(await devices.getActivation(req.valid.params.id, scope(req)));
  });
}

/**
 * Dispositivos POR MAC (revendedores). O MAC só localiza a TV; quem pode agir é o usuário autenticado cujo
 * cadastro de revendedor está ativo (token). Cada chamada é auditada com a pessoa e o revendedor.
 * O MAC vai no corpo (não na URL) para não ficar em logs de acesso.
 */
const macBody = z.object({ mac: z.string().trim().min(12).max(17) });
const requireReseller = async (req, _res, next) => {
  const partner = await reseller.loadReseller(req.user.partnerId);
  reseller.assertReseller(partner);
  req.reseller = { partner };
  next();
};
const resellerCtx = (req) => ({ partner: req.reseller.partner, actor: actorOf(req) });

router.post("/mac/lookup", macLookupLimiter, requireReseller, validate({ body: macBody }), async (req, res) =>
  res.json(await reseller.lookupByMac({ ...resellerCtx(req), mac: req.valid.body.mac })));
router.post("/mac/history", macLookupLimiter, requireReseller, validate({ body: macBody }), async (req, res) =>
  res.json(await reseller.historyByMac({ ...resellerCtx(req), mac: req.valid.body.mac })));
router.post("/mac/configure", macWriteLimiter, requireReseller, validate({ body: z.object({ mac: macBody.shape.mac, configuration: configurationSchema }) }), async (req, res) =>
  res.json(await reseller.configureByMac({ ...resellerCtx(req), mac: req.valid.body.mac, input: req.valid.body.configuration })));
router.post("/mac/remove-list", macWriteLimiter, requireReseller, validate({ body: z.object({ mac: macBody.shape.mac, reason: z.string().trim().min(3).max(500).optional(), activationId: z.string().uuid().optional() }) }), async (req, res) =>
  res.json(await reseller.removeListByMac({ ...resellerCtx(req), mac: req.valid.body.mac, reason: req.valid.body.reason, activationId: req.valid.body.activationId })));

/**
 * Estoque de licenças do revendedor: saldo/extrato, transferência para outro revendedor (pelo e-mail dele) e aplicação
 * ao MAC de um cliente. O revendedor vem do token; nada de partnerId do cliente.
 */
// Duração padrão: 1 mês (quando o campo é omitido).
const monthsField = z.number().int().min(1).max(120).default(1);
router.get("/stock", requireReseller, validate({ query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.json(await stock.stockOf(req.user.partnerId, req.valid.query)));
router.post("/stock/recipient", stockLookupLimiter, requireReseller, validate({ body: z.object({ email: z.string().trim().email().max(200) }) }), async (req, res) =>
  res.json(await stock.lookupRecipient({ partner: req.reseller.partner, email: req.valid.body.email })));
router.post("/stock/transfer", stockWriteLimiter, requireReseller,
  validate({ body: z.object({ email: z.string().trim().email().max(200), months: monthsField, quantity: z.number().int().min(1).max(1000), note: z.string().trim().max(200).optional() }) }),
  async (req, res) => res.json(await stock.transferStock({ ...resellerCtx(req), ...req.valid.body })));
router.post("/stock/apply", stockWriteLimiter, requireReseller, validate({ body: z.object({ mac: macBody.shape.mac, months: monthsField }) }), async (req, res) =>
  res.json(await reseller.applyStockByMac({ ...resellerCtx(req), mac: req.valid.body.mac, months: req.valid.body.months })));

router.get("/codes/check", codeCheckLimiter, validate({ query: z.object({ code: z.string().max(40) }) }), async (req, res) => res.json(await partners.checkCode(req.valid.query.code)));
router.get("/codes", async (req, res) => res.json({ data: await partners.listCodes(req.user.partnerId) }));
// Servidores do provedor: somente leitura para o parceiro (o cadastro é feito pela plataforma).
router.get("/providers", async (req, res) => res.json({ data: (await listProviders(req.user.partnerId)).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, status: p.status })) }));
router.post("/codes", validate({ body: z.object({ code: z.string().trim().min(4).max(12).optional(), label: z.string().max(120).optional(), maxActivations: z.number().int().min(1).nullable().optional(), expiresAt: z.coerce.date().nullable().optional(), providerId: z.string().uuid().nullable().optional() }) }), async (req, res) =>
  res.status(201).json(await partners.createCode(req.user.partnerId, req.valid.body, actorOf(req))));
router.post("/codes/:id/revoke", validate({ params: id }), async (req, res) => {
  await partners.revokeCode(req.user.partnerId, req.valid.params.id, actorOf(req));
  res.status(204).end();
});

router.get("/invoices", validate({ query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.json(await listInvoices({ ...req.valid.query, partnerId: req.user.partnerId })));

export default router;
