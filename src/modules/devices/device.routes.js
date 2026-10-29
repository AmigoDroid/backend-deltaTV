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

const router = Router();
const id = z.object({ id: z.string().uuid() });

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

router.get(
  "/", requirePermission("devices:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(40).optional(), online: z.enum(["true", "false"]).optional(), status: z.enum(["active", "blocked", "revoked"]).optional(), licenseId: z.string().uuid().optional(), partnerId: z.string().uuid().optional() }) }),
  async (req, res) => res.json(await svc.listActivations(req.valid.query)),
);
router.get("/history", requirePermission("devices:read"), validate({ query: z.object({ mac: z.string().min(11).max(20) }) }), async (req, res) => res.json(await svc.deviceHistory(req.valid.query.mac)));
router.get("/activations/:id", requirePermission("devices:read"), validate({ params: id }), async (req, res) => res.json(await svc.getActivation(req.valid.params.id)));

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

export default router;
