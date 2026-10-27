import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { clientWriteLimiter } from "../../middleware/security.js";
import { FILTERS } from "./client.rules.js";
import { clientBody } from "./client.routes.js";
import * as svc from "./client.admin.service.js";

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
