import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { clientWriteLimiter } from "../../middleware/security.js";
import { FILTERS } from "./client.rules.js";
import { clientBody, expirySettingsSchema } from "./client.routes.js";
import * as svc from "./client.admin.service.js";
import { Partner } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { getSettings, setSettings } from './expiry-notice.service.js';

/**
 * Clientes das revendas no painel admin (/api/v1/admin/clients). Diferente do portal, o partnerId vem do pedido: o admin
 * enxerga e edita as fichas de QUALQUER revenda. Leitura: clients:read; escrita: clients:write (admin e superadmin).
 */
const router = Router();
const id = z.object({ id: z.string().uuid() });
const partnerId = z.string().uuid();

router.get("/", requirePermission("clients:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(60).optional(), filter: z.enum(FILTERS).optional(), partnerId: partnerId.optional() }) }),
  async (req, res) => res.json(await svc.adminList(req.valid.query)));
router.get("/summary", requirePermission("clients:read"), validate({ query: z.object({ partnerId: partnerId.optional() }) }),
  async (req, res) => res.json(await svc.adminSummary(req.valid.query.partnerId)));
// Ficha única, sem novos registros no banco. Operador só lê dados permitidos.
router.get('/:id/support', requirePermission('clients:read'), validate({ params: id }),
  async (req,res) => {
    const { supportForClient } = await import('../support/support.service.js');
    res.set('Cache-Control','no-store').json(await supportForClient(req.valid.params.id));
  });

// O admin/superadmin pode gerenciar a MESMA regra que a revenda enxerga, sem criar duplicatas.
// Toda parceria com cadastro de clientes possui sua própria regra; conteúdo e revenda são isolados por partner_id.
async function assertExpiryReseller(id) {
  const partner = await Partner.findByPk(id, { attributes: ['id', 'kind'] });
  if (!partner || !['reseller', 'both', 'content'].includes(partner.kind)) {
    throw new AppError(422, 'INVALID_PARTNER', 'Selecione uma revenda ou parceiro de conteúdo válido.');
  }
}
router.get('/expiry-notice-settings/:partnerId', requirePermission('clients:read'),
  validate({ params: z.object({ partnerId }) }),
  async (req, res) => {
    const id = req.valid.params.partnerId;
    await assertExpiryReseller(id);
    res.set('Cache-Control', 'no-store').json(await getSettings(id));
  });
router.put('/expiry-notice-settings/:partnerId', requirePermission('clients:write'), clientWriteLimiter,
  validate({ params: z.object({ partnerId }), body: expirySettingsSchema }),
  async (req, res) => {
    const id = req.valid.params.partnerId;
    await assertExpiryReseller(id);
    res.set('Cache-Control', 'no-store').json(await setSettings(id, req.valid.body, actorOf(req)));
  });

router.post("/", requirePermission("clients:write"), clientWriteLimiter,
  validate({ body: clientBody.extend({ partnerId }) }),
  async (req, res) => res.status(201).json(await svc.adminCreate({ actor: actorOf(req), input: req.valid.body })));
router.patch("/:id", requirePermission("clients:write"), clientWriteLimiter,
  validate({ params: id, body: clientBody.partial().extend({ partnerId: partnerId.optional() }).refine((b) => Object.keys(b).length > 0, "Nada para alterar.") }),
  async (req, res) => res.json(await svc.adminUpdate({ id: req.valid.params.id, actor: actorOf(req), input: req.valid.body })));
router.delete("/:id", requirePermission("clients:write"), clientWriteLimiter, validate({ params: id }), async (req, res) => {
  await svc.adminDelete({ id: req.valid.params.id, actor: actorOf(req) });
  res.status(204).end();
});

export default router;
