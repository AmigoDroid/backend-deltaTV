import { auditParams, auditRead } from '../connection-audit/routes.js';
import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { macWriteLimiter } from "../../middleware/security.js";
import * as svc from "./device.service.js";
import * as registration from "./registration.service.js";
import * as unlinked from "./unlinked.service.js";
import { configurationSchema as configuration } from "./device-config.schema.js";
import { countOnline } from "./presence.js";
import { env } from "../../config/env.js";

import { activationDeletionPreview, deviceDeletionPreview, deleteActivationAsSuper, deleteDeviceAsSuper } from "../admin-deletion.service.js";

import { Activation } from "../../db/models/index.js";
import { credentialsOf } from "../clients/client.service.js";
import { notFound } from "../../shared/errors.js";
const router = Router();
const id = z.object({ id: z.string().uuid() });
router.get("/activations/:id/connection-audit", requirePermission("devices:read"), auditParams, auditRead(false));

router.get(
  "/registrations",
  requirePermission("devices:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().trim().max(100).optional() }) }),
  async (req, res) => res.json(await registration.findRegisteredDevices(req.valid.query)),
);
router.get(
  "/registrations/:id",
  requirePermission("devices:read"),
  validate({ params: id }),
  async (req, res) => res.json(await registration.registeredDeviceById(req.valid.params.id)),
);
router.post(
  "/registrations/:id/configuration",
  requirePermission("devices:write"),
  validate({ params: id, body: configuration }),
  async (req, res) => res.json(await registration.configureDeviceByAdmin(
    req.valid.params.id, req.valid.body, actorOf(req),
  )),
);

// Remove UMA lista do MAC pelo painel, sem precisar da chave da TV. Com várias listas, `activationId` é obrigatório.
router.post(
  "/registrations/:id/remove-list",
  requirePermission("devices:write"),
  validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500).optional(), activationId: z.string().uuid().optional() }) }),
  async (req, res) => res.json(await svc.removeListByAdmin(req.valid.params.id, req.valid.body, actorOf(req))),
);


// Transferência de licença concedida pelo revendedor: o superadmin seleciona explicitamente
// o revendedor proprietário, sem desabilitar validações de posse, prazo ou MAC destino.
router.post("/activations/:id/transfer-license", requirePermission("override"), macWriteLimiter,
  validate({ params: id, body: z.object({ toMac: z.string().trim().min(11).max(20), reason: z.string().trim().min(5).max(500) }) }),
  async (req, res) => {
    const { Activation, Partner, Device } = await import("../../db/models/index.js");
    const { normalizeMac } = await import("../../shared/mac.js");
    const { transferGrantedLicense } = await import("../stock/license-transfer.service.js");
    const { audit } = await import("../../shared/audit.js");
    const activation = await Activation.findByPk(req.valid.params.id);
    if (!activation?.partnerId || !activation.grantedLicenseId) throw notFound("Licença concedida");
    const partner = await Partner.findByPk(activation.partnerId);
    if (!partner) throw notFound("Revendedor");
    const mac = normalizeMac(req.valid.body.toMac);
    if (!mac) throw new (await import("../../shared/errors.js")).AppError(422, "INVALID_MAC", "MAC inválido.");
    const device = await Device.findOne({ where: { mac } });
    if (!device) throw notFound("Dispositivo de destino");
    const result = await transferGrantedLicense({ partner, actor: actorOf(req), activationId: activation.id, toDevice: device });
    await audit({ actor: actorOf(req), action: "admin.license.transfer", entityType: "license", entityId: result.licenseId,
      metadata: { reason: req.valid.body.reason, fromMac: result.fromMac, toMac: result.toMac } });
    res.json(result);
  });

/* ---------- Dispositivos sem vínculo + cadastro direto pelo painel ---------- */
// Código curto da parceria + usuário/senha do provedor. Mesmas regras do app (client.routes) e de configurationSchema.
const credentials = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/, "Código inválido: use de 4 a 12 letras ou números."),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(128),
});

router.get(
  "/unlinked", requirePermission("devices:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().trim().max(40).optional() }) }),
  async (req, res) => res.json(await unlinked.listUnlinkedDevices(req.valid.query)),
);
// Cadastra um dispositivo novo: MAC + código + usuário + senha. O limite por usuário protege contra uso como "testador" de senhas.
router.post(
  "/register", requirePermission("devices:write"), macWriteLimiter,
  validate({ body: credentials.extend({ mac: z.string().trim().min(11).max(20) }) }),
  async (req, res) => res.status(201).json(await unlinked.registerDeviceFromPanel(req.valid.body, actorOf(req))),
);
// Vincula um dispositivo que já está na lista de "sem vínculo".
router.post(
  "/unlinked/:id/link", requirePermission("devices:write"), macWriteLimiter,
  validate({ params: id, body: credentials }),
  async (req, res) => res.json(await unlinked.linkUnlinkedDevice(req.valid.params.id, req.valid.body, actorOf(req))),
);
router.delete(
  "/unlinked/:id", requirePermission("devices:write"), macWriteLimiter,
  validate({ params: id }),
  async (req, res) => {
    await unlinked.removeUnlinkedDevice(req.valid.params.id, actorOf(req));
    res.status(204).end();
  },
);

// Contagem leve de aparelhos online agora (o painel consulta a cada ~20 s).
router.get("/presence", requirePermission("devices:read"), async (_req, res) =>
  res.set("Cache-Control", "no-store").json({ online: await countOnline(), windowSeconds: env.presenceWindowSeconds }));

router.get("/by-mac", requirePermission("devices:read"), validate({ query: z.object({
  ...pageQuery, q: z.string().max(40).optional(), online: z.enum(["true", "false"]).optional(),
  status: z.enum(["active", "blocked", "revoked", "unlinked"]).optional(),
}) }), async (req, res) => res.set("Cache-Control", "no-store").json(await svc.listDevices(req.valid.query)));

router.get(
  "/", requirePermission("devices:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(40).optional(), online: z.enum(["true", "false"]).optional(), status: z.enum(["active", "blocked", "revoked"]).optional(), licenseId: z.string().uuid().optional(), partnerId: z.string().uuid().optional() }) }),
  async (req, res) => res.json(await svc.listActivations(req.valid.query)),
);
router.get("/history", requirePermission("devices:read"), validate({ query: z.object({ ...pageQuery, mac: z.string().min(11).max(20) }) }), async (req, res) => res.set("Cache-Control", "no-store").json(await svc.deviceHistory(req.valid.query.mac, req.valid.query)));
router.get("/activations/:id", requirePermission("devices:read"), validate({ params: id }), async (req, res) => res.json(await svc.getActivation(req.valid.params.id)));
router.get("/registrations/:id/attribution", requirePermission("devices:read"), validate({ params: id }), async (req, res) => res.json(await svc.deviceAttribution(req.valid.params.id)));

// Exclusão permanente exclusiva do superadmin. Prévia obrigatória na interface.
const deletionBody = z.object({ confirmMac: z.string().trim().min(11).max(30), reason: z.string().trim().max(400).optional() }).strict();
router.get("/activations/:id/deletion-preview", requirePermission("override"), validate({ params: id }), async (req, res) => res.json(await activationDeletionPreview(req.valid.params.id, actorOf(req))));
router.delete("/activations/:id", requirePermission("override"), validate({ params: id, body: deletionBody }), async (req, res) => res.json(await deleteActivationAsSuper(req.valid.params.id, req.valid.body, actorOf(req))));
router.get("/registrations/:id/deletion-preview", requirePermission("override"), validate({ params: id }), async (req, res) => res.json(await deviceDeletionPreview(req.valid.params.id, actorOf(req))));
router.delete("/registrations/:id", requirePermission("override"), validate({ params: id, body: deletionBody }), async (req, res) => res.json(await deleteDeviceAsSuper(req.valid.params.id, req.valid.body, actorOf(req))));

// Edição completa do dispositivo: SÓ superadmin (permissão "devices:edit" não existe nos outros perfis).
router.patch(
  "/activations/:id", requirePermission("devices:edit"),
  validate({
    params: id,
    body: z.object({
      deliveryMode: z.enum(["proxy", "redirect"]).nullable().optional(),
      playlistName: z.string().trim().min(1).max(160).optional(),
      playlistUrl: z.string().trim().min(1).max(2048).optional(),
      removeList: z.boolean().optional(),
    }),
  }),
  async (req, res) => res.json(await svc.editActivation(req.valid.params.id, req.valid.body, actorOf(req))),
);

// "restore" (desfazer remoção) só existe para o superadmin: a permissão "override" não está em nenhum outro perfil.
for (const action of ["block", "unblock", "revoke", "restore"]) {
  router.post(`/activations/:id/${action}`, requirePermission(action === "restore" ? "override" : "devices:write"), validate({ params: id, body: z.object({ reason: z.string().trim().min(3).max(500).optional() }) }), async (req, res) => {
    await svc.changeActivation(req.valid.params.id, action, { reason: req.valid.body.reason, actor: actorOf(req), blockedBy: "admin" });
    res.json(await svc.getActivation(req.valid.params.id));
  });
}

router.post("/activations/:id/credentials",requirePermission("override"),macWriteLimiter,validate({params:id}),async(req,res)=>{
 const a=await Activation.findByPk(req.valid.params.id);if(!a)throw notFound("Ativação");
 res.set("Cache-Control","no-store").json(await credentialsOf({partnerId:a.partnerId,activationId:a.id,actor:actorOf(req)}));
});
export default router;
