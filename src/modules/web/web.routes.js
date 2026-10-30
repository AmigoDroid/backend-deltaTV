import { Router } from "express";
import { z } from "zod";
import { Device, Partner } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { AppError, notFound } from "../../shared/errors.js";
import { normalizeMac } from "../../shared/mac.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { macWriteLimiter, stockWriteLimiter, webLoginIpLimiter, webLoginCodeLimiter } from "../../middleware/security.js";
import * as reseller from "../devices/reseller-devices.service.js";
import * as svc from "./web-access.service.js";
import { MODE_VALUES } from "./web-modes.js";

/**
 * Player Web — três portas para o mesmo serviço (web-access.service.js):
 *   partnerRouter  /api/v1/partner/web-access   revendedor: só os acessos DELE (o partnerId vem do token)
 *   adminRouter    /api/v1/admin/web-access     admin: todos (superadmin pode tudo; permissões web:read / web:write)
 *   clientRouter   /api/v1/client/web/login     cliente do player, com o código AB123456 (público, com limitadores)
 */
const id = z.object({ id: z.string().uuid() });
const reason = z.object({ reason: z.string().trim().min(3).max(500).optional() });
const months = z.number().int().min(1).max(120);

const modeField = z.enum(MODE_VALUES);
const modesSchema = z.object({ api: modeField.optional(), live: modeField.optional(), movie: modeField.optional(), series: modeField.optional() }).strict();

const configSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("partner"),
    code: z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/, "Código inválido: use de 4 a 12 letras ou números."),
    username: z.string().trim().min(1).max(128),
    password: z.string().min(1).max(128),
  }),
  z.object({ mode: z.literal("playlist"), name: z.string().trim().min(1).max(160), url: z.string().trim().min(1).max(2048) }),
]);

// A lista vem de UMA fonte: copiada de um MAC (a TV do cliente) ou informada na hora.
const sourceOk = (b) => (b.mac ? 1 : 0) + (b.config ? 1 : 0) === 1;
const sourceMsg = { message: "Informe o MAC da TV do cliente OU a lista (servidor ou link), não os dois.", path: ["mac"] };
const createFields = {
  label: z.string().trim().min(1).max(160).optional(),
  mac: z.string().trim().min(11).max(20).optional(),
  activationId: z.string().uuid().optional(),
  config: configSchema.optional(),
  months: months.optional(),
  modes: modesSchema.optional(),
};
const patchBody = z.object({ label: z.string().trim().min(1).max(160).optional(), deliveryModes: modesSchema.nullable().optional() });
// Revendedor NÃO altera o modo de entrega (proxy/redirect): isso é só do admin. O acesso nasce com o padrão do web.
const { modes: _noModes, ...partnerCreateFields } = createFields;
const partnerPatchBody = z.object({ label: z.string().trim().min(1).max(160).optional() });
const listQuery = z.object({ ...pageQuery, q: z.string().trim().max(60).optional(), status: z.enum(["active", "blocked", "revoked"]).optional() });
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

/* ---------------------------------------------------------------- revendedor */
export const partnerRouter = Router();
partnerRouter.use(noStore);
const requireReseller = async (req, _res, next) => {
  const partner = await reseller.loadReseller(req.user.partnerId);
  reseller.assertReseller(partner);
  req.reseller = { partner };
  next();
};
partnerRouter.use(requireReseller);
const scope = (req) => ({ partnerId: req.user.partnerId });

partnerRouter.get("/", validate({ query: listQuery }), async (req, res) => res.json(await svc.listWebAccesses(req.valid.query, scope(req))));
partnerRouter.get("/:id", validate({ params: id }), async (req, res) => res.json(await svc.getWebAccess(req.valid.params.id, scope(req))));

partnerRouter.post("/", macWriteLimiter, validate({ body: z.object(partnerCreateFields).refine(sourceOk, sourceMsg) }), async (req, res) => {
  const { mac, activationId, config: given, months: m, label } = req.valid.body;
  const actor = actorOf(req);
  const partner = req.reseller.partner;
  const config = mac
    ? await svc.configFromActivation(await reseller.activationForCopy({ partner, actor, mac, activationId }))
    : given;
  res.status(201).json(await svc.createWebAccess({ partner, actor, label, config, months: m, useStock: true }));
});

partnerRouter.patch("/:id", macWriteLimiter, validate({ params: id, body: partnerPatchBody }), async (req, res) =>
  res.json(await svc.updateWebAccess(req.valid.params.id, req.valid.body, { actor: actorOf(req), scope: scope(req) })));

for (const action of ["block", "unblock", "revoke"]) {
  partnerRouter.post(`/:id/${action}`, macWriteLimiter, validate({ params: id, body: reason }), async (req, res) =>
    res.json(await svc.changeStatus(req.valid.params.id, action, { reason: req.valid.body.reason, actor: actorOf(req), scope: scope(req), role: "partner" })));
}
partnerRouter.post("/:id/renew", stockWriteLimiter, validate({ params: id, body: z.object({ months: months.default(1) }) }), async (req, res) =>
  res.json(await svc.renew(req.valid.params.id, { months: req.valid.body.months, actor: actorOf(req), scope: scope(req), useStock: true })));

/* ---------------------------------------------------------------- admin */
export const adminRouter = Router();
adminRouter.use(noStore);

adminRouter.get("/", requirePermission("web:read"), validate({ query: listQuery.extend({ partnerId: z.string().uuid().optional() }) }), async (req, res) =>
  res.json(await svc.listWebAccesses(req.valid.query)));
adminRouter.get("/:id", requirePermission("web:read"), validate({ params: id }), async (req, res) => res.json(await svc.getWebAccess(req.valid.params.id)));

adminRouter.post("/", requirePermission("web:write"), macWriteLimiter,
  validate({ body: z.object({ ...createFields, partnerId: z.string().uuid().optional(), useStock: z.boolean().optional() }).refine(sourceOk, sourceMsg) }),
  async (req, res) => {
    const { mac, activationId, config: given, months: m, label, modes, partnerId, useStock } = req.valid.body;
    const actor = actorOf(req);
    const partner = partnerId ? await Partner.findByPk(partnerId) : null;
    if (partnerId && !partner) throw notFound("Revendedor");
    let config = given;
    if (mac) {
      // Admin pode copiar de qualquer MAC (sem a trava de "dono da lista" do revendedor).
      const norm = normalizeMac(mac);
      const device = norm ? await Device.findOne({ where: { mac: norm } }) : null;
      if (!device) throw new AppError(404, "DEVICE_NOT_FOUND", "MAC não encontrado.");
      config = await svc.configFromActivation(await reseller.selectLiveActivation(device.id, activationId));
    }
    res.status(201).json(await svc.createWebAccess({ partner, actor, label, config, months: m, useStock: useStock ?? !!partner, modes }));
  });

adminRouter.patch("/:id", requirePermission("web:write"), validate({ params: id, body: patchBody }), async (req, res) =>
  res.json(await svc.updateWebAccess(req.valid.params.id, req.valid.body, { actor: actorOf(req) })));
for (const action of ["block", "unblock", "revoke"]) {
  adminRouter.post(`/:id/${action}`, requirePermission("web:write"), validate({ params: id, body: reason }), async (req, res) =>
    res.json(await svc.changeStatus(req.valid.params.id, action, { reason: req.valid.body.reason, actor: actorOf(req), role: "admin" })));
}
adminRouter.post("/:id/renew", requirePermission("web:write"), validate({ params: id, body: z.object({ months: months.default(1), useStock: z.boolean().default(false) }) }), async (req, res) =>
  res.json(await svc.renew(req.valid.params.id, { months: req.valid.body.months, actor: actorOf(req), useStock: req.valid.body.useStock })));

/* ---------------------------------------------------------------- cliente do player */
export const clientRouter = Router();
clientRouter.post("/login", webLoginIpLimiter, webLoginCodeLimiter, validate({ body: z.object({ code: z.string().trim().min(6).max(20) }) }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await svc.loginWithCode({ code: req.valid.body.code, ip: req.ip, userAgent: req.get("user-agent") })));
