import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { clientWriteLimiter, credentialsViewLimiter } from "../../middleware/security.js";
import { loadReseller, assertReseller } from "../devices/reseller-devices.service.js";
import { FILTERS } from "./client.rules.js";
import * as svc from "./client.service.js";
import { DEFAULT_EXPIRY_SETTINGS, validTemplate } from './expiry-notice.rules.js';
import { getSettings, setSettings } from './expiry-notice.service.js';

/**
 * Clientes do revendedor (/api/v1/partner/clients). Montado depois de authenticate + requirePartnerRole: o partnerId vem
 * SEMPRE do token. Só revendedores ativos usam (mesma regra das demais telas por MAC). O formato dos campos é checado aqui;
 * as regras de conteúdo (telefone, data, tamanhos) ficam em client.rules.js / client.service.js.
 */
const router = Router();
router.use(async (req, _res, next) => {
  assertReseller(await loadReseller(req.user.partnerId));
  next();
});

const id = z.object({ id: z.string().uuid() });
const text = (max) => z.string().max(max * 2).nullable().optional(); // folga: o limite exato é aplicado após normalizar espaços
export const clientBody = z.object({
  mac: z.string().max(40),
  name: z.string().max(400), phone: text(30), address: text(300), notes: text(500),
  priceCents: z.number().int().nullable().optional(), dueDate: z.string().max(10).nullable().optional(),
});

router.get("/", validate({ query: z.object({ ...pageQuery, q: z.string().max(60).optional(), filter: z.enum(FILTERS).optional() }) }), async (req, res) =>
  res.json(await svc.listClients({ partnerId: req.user.partnerId, ...req.valid.query })));
// POST (e não GET) para o id não ficar em log de acesso nem em cache; resposta nunca é guardada.
router.post("/credentials", credentialsViewLimiter, validate({ body: z.object({ activationId: z.string().uuid() }) }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await svc.credentialsOf({ partnerId: req.user.partnerId, activationId: req.valid.body.activationId, actor: actorOf(req) })));
router.get("/summary", async (req, res) => res.json(await svc.summary(req.user.partnerId)));
// Mesmo diagnóstico do superadmin, mas escopo SEMPRE do JWT do parceiro.
router.get('/:id/support', validate({ params: id }), async (req,res) => {
  const { supportForClient } = await import('../support/support.service.js');
  res.set('Cache-Control','no-store').json(await supportForClient(req.valid.params.id,req.user.partnerId));
});
// Configuração ÚNICA por revenda, aplicada a todas as fichas do mesmo parceiro.
export const expirySettingsSchema = z.object({
  enabled: z.boolean(), daysBefore: z.number().int().min(1).max(30),
  messageMode: z.enum(['service','channels','custom']),
  deliveryMode: z.enum(['daily', 'every_open']).optional(),
  customBefore: z.string().min(1).max(180).refine(validTemplate, 'Use apenas {prazo}, {dias} e {data}.'),
  customToday: z.string().min(1).max(180).refine(validTemplate, 'Use apenas {prazo}, {dias} e {data}.'),
}).strict();
router.get('/expiry-notice-settings', async (req,res) => res.set('Cache-Control','no-store').json(await getSettings(req.user.partnerId)));
router.put('/expiry-notice-settings', clientWriteLimiter,
  validate({ body: expirySettingsSchema }), async (req,res) => res.set('Cache-Control','no-store')
    .json(await setSettings(req.user.partnerId, req.valid.body, actorOf(req))));


router.post("/", clientWriteLimiter, validate({ body: clientBody }), async (req, res) =>
  res.status(201).json(await svc.createClient({ partnerId: req.user.partnerId, actor: actorOf(req), input: req.valid.body })));
router.patch("/:id", clientWriteLimiter, validate({ params: id, body: clientBody.partial().refine((b) => Object.keys(b).length > 0, "Nada para alterar.") }), async (req, res) =>
  res.json(await svc.updateClient({ partnerId: req.user.partnerId, id: req.valid.params.id, actor: actorOf(req), input: req.valid.body })));
router.delete("/:id", clientWriteLimiter, validate({ params: id }), async (req, res) => {
  await svc.deleteClient({ partnerId: req.user.partnerId, id: req.valid.params.id, actor: actorOf(req) });
  res.status(204).end();
});

export default router;
