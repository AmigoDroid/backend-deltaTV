/** Operational tools for CONTENT partners.
 * Mounted under /api/v1/content-partner after authentication + content-kind gate.
 * Do not mount reseller stock/credit-purchase routes: content contracts have different accounting.
 */
import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { Partner, PartnerCode, Activation } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { clientWriteLimiter, credentialsViewLimiter, macWriteLimiter } from "../../middleware/security.js";
import { pageQuery } from "../../shared/pagination.js";
import { clientBody } from "../clients/client.routes.js";
import { FILTERS } from "../clients/client.rules.js";
import * as clients from "../clients/client.service.js";
import * as devices from "../devices/device.service.js";
import * as registration from "../devices/registration.service.js";
import * as billing from "../billing/billing.service.js";
import * as downloads from "../downloads/download.service.js";
import * as credits from "../credits/credit.service.js";
import * as web from "../web/web-access.service.js";
import { partnerNotificationRoutes } from "../notifications/notification.routes.js";

const router = Router();
const id = z.object({ id: z.string().uuid() });
const paging = z.object({ ...pageQuery });
const scope = req => ({ partnerId: req.user.partnerId });
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
router.use(noStore);

// Notifications share the existing delivery/read tracking, but always use partnerId from the JWT.
router.use("/notifications", partnerNotificationRoutes);
router.get("/account", async (req, res) => {
  const p = await Partner.findByPk(req.user.partnerId, { attributes: ["id", "name", "slug", "kind", "status", "contactName", "contactEmail", "contactPhone", "startsAt", "endsAt", "billingModel", "deviceLimit"] });
  if (!p) throw notFound("Parceiro");
  res.json(p);
});
router.patch("/account", validate({ body: z.object({ contactName: z.string().trim().max(160).nullable().optional(), contactPhone: z.string().trim().max(40).nullable().optional() }).strict().refine(b => Object.keys(b).length > 0) }), async (req, res) => {
  const p = await Partner.findByPk(req.user.partnerId);
  if (!p) throw notFound("Parceiro");
  await p.update(req.valid.body);
  await audit({ actor: actorOf(req), action: "content.partner.contact.update", entityType: "partner", entityId: p.id, metadata: { fields: Object.keys(req.valid.body) } });
  res.json({ ok: true });
});

// Customer CRM: reuses the same isolated MAC-based customer service as the reseller,
// but NOT its reseller-only stock, purchase, license-transfer, or login privileges.
router.get("/clients", validate({ query: z.object({ ...pageQuery, q: z.string().max(60).optional(), filter: z.enum(FILTERS).optional() }) }), async (req, res) => {
  // The shared SQL validates the filter; use its public defined filter set below.
  res.json(await clients.listClients({ partnerId: req.user.partnerId, ...req.valid.query }));
});
router.get("/clients/summary", async (req, res) => res.json(await clients.summary(req.user.partnerId)));
router.post("/clients", clientWriteLimiter, validate({ body: clientBody }), async (req, res) => res.status(201).json(await clients.createClient({ partnerId: req.user.partnerId, actor: actorOf(req), input: req.valid.body })));
router.patch("/clients/:id", clientWriteLimiter, validate({ params: id, body: clientBody.partial().refine(b => Object.keys(b).length > 0) }), async (req, res) => res.json(await clients.updateClient({ partnerId: req.user.partnerId, actor: actorOf(req), id: req.valid.params.id, input: req.valid.body })));
router.delete("/clients/:id", clientWriteLimiter, validate({ params: id }), async (req, res) => { await clients.deleteClient({ partnerId: req.user.partnerId, actor: actorOf(req), id: req.valid.params.id }); res.status(204).end(); });
// Credential access is opt-in, rate limited, audited, and only for the partner's activation.
router.post("/clients/credentials", credentialsViewLimiter, validate({ body: z.object({ activationId: z.string().uuid() }) }), async (req, res) => res.json(await clients.credentialsOf({ partnerId: req.user.partnerId, actor: actorOf(req), activationId: req.valid.body.activationId })));

router.get("/licenses", validate({ query: z.object({ ...pageQuery, q: z.string().max(40).optional(), status: z.enum(["active", "blocked", "revoked"]).optional(), online: z.enum(["true", "false"]).optional() }) }), async (req, res) => res.json(await devices.listActivations(req.valid.query, scope(req))));
router.get("/devices/:id", validate({ params: id }), async (req, res) => res.json(await devices.getActivation(req.valid.params.id, scope(req))));
for (const action of ["block", "unblock"]) {
  router.post(`/devices/:id/${action}`, macWriteLimiter, validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500).optional() }).default({}) }), async (req, res) => {
    await devices.changeActivation(req.valid.params.id, action, { scope: scope(req), actor: actorOf(req), reason: req.valid.body.reason, blockedBy: "partner" });
    res.json(await devices.getActivation(req.valid.params.id, scope(req)));
  });
}

// Configuração de lista somente em uma ativação já pertencente ao parceiro.
// Nunca aceita deviceId/partnerId arbitrário enviado pelo navegador.
router.post("/devices/:id/configure", macWriteLimiter, validate({
  params: id,
  body: z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/), username: z.string().trim().min(1).max(128), password: z.string().min(1).max(128) }),
}), async (req, res) => {
  const a = await Activation.findOne({where:{id:req.valid.params.id,partnerId:req.user.partnerId,status:{[Op.ne]:"revoked"}},attributes:["id","deviceId"]});
  if (!a) throw notFound("Ativação");
  const owned = await PartnerCode.findOne({where:{partnerId:req.user.partnerId,code:{[Op.iLike]:req.valid.body.code},status:"active",licenseMonths:null}});
  if (!owned) throw new AppError(404,"CODE_NOT_FOUND","Código de conteúdo da sua parceria não encontrado.");
  await registration.configureDeviceByAdmin(a.deviceId, {mode:"partner",confirm:true,code:owned.code,username:req.valid.body.username,password:req.valid.body.password}, actorOf(req));
  res.json(await devices.getActivation(a.id,scope(req)));
});

// Contract financials: READ ONLY. A content partner cannot forge payments or invoices.
router.get("/invoices", validate({ query: paging }), async (req, res) => res.json(await billing.listInvoices({ ...req.valid.query, partnerId: req.user.partnerId })));
router.get("/payments", validate({ query: paging }), async (req, res) => res.json(await billing.listPayments({ ...req.valid.query, partnerId: req.user.partnerId })));
router.get("/credit-ledger", validate({ query: paging }), async (req, res) => res.json(await credits.listLedger({ ...req.valid.query, partnerId: req.user.partnerId })));
router.get("/downloads", validate({ query: z.object({ ...pageQuery, q: z.string().trim().max(60).optional(), kind: z.enum(["app", "link"]).optional() }) }), async (req, res) => res.json(await downloads.listDownloads(req.valid.query)));

// Web player: only permits EXISTING content-partner codes. Never grants courtesy
// licenses or charges unrelated reseller stock. Activation follows the code contract.
router.get("/web-access", validate({ query: z.object({ ...pageQuery, q: z.string().trim().max(60).optional(), status: z.enum(["active", "blocked", "revoked"]).optional() }) }), async (req, res) => res.json(await web.listWebAccesses(req.valid.query, scope(req))));
router.post("/web-access", macWriteLimiter, validate({ body: z.object({ label: z.string().trim().max(160).optional(), code: z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/), username: z.string().trim().min(1).max(128), password: z.string().min(1).max(128) }) }), async (req, res) => {
  const { label, code, username, password } = req.valid.body;
  const owned = await PartnerCode.findOne({ where: { partnerId: req.user.partnerId, code: { [Op.iLike]: code }, status: "active", licenseMonths: null } });
  if (!owned) throw new AppError(404, "CODE_NOT_FOUND", "Código ativo da sua parceria não encontrado, ou está vinculado ao estoque de revenda.");
  const p = await Partner.findByPk(req.user.partnerId);
  const result = await web.createWebAccess({ partner: p, actor: actorOf(req), label, config: { mode: "partner", code: owned.code, username, password }, useStock: false });
  res.status(201).json(result);
});
for (const action of ["block", "unblock", "revoke"]) {
  router.post(`/web-access/:id/${action}`, macWriteLimiter, validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500).optional() }).default({}) }), async (req, res) => {
    res.json(await web.changeStatus(req.valid.params.id, action, { scope: scope(req), actor: actorOf(req), role: "partner", reason: req.valid.body.reason }));
  });
}
export default router;
