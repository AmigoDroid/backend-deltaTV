import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { currentCompetence } from "../../shared/dates.js";
import { requirePermission } from "../../middleware/authenticate.js";
import * as svc from "./billing.service.js";

const router = Router();
const id = z.object({ id: z.string().uuid() });
const competence = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

router.get(
  "/invoices", requirePermission("billing:read"),
  validate({ query: z.object({ ...pageQuery, status: z.enum(["open", "partial", "paid", "overdue", "cancelled"]).optional(), partnerId: z.string().uuid().optional(), competence: competence.optional() }) }),
  async (req, res) => res.json(await svc.listInvoices(req.valid.query)),
);
router.get("/payments", requirePermission("billing:read"), validate({ query: z.object({ ...pageQuery, partnerId: z.string().uuid().optional() }) }), async (req, res) => res.json(await svc.listPayments(req.valid.query)));

router.post("/invoices/generate", requirePermission("billing:write"), validate({ body: z.object({ competence: competence.default(currentCompetence()) }) }), async (req, res) =>
  res.json(await svc.generateForAll(req.valid.body.competence, actorOf(req))));

// Confirmação administrativa (auditada). Confirmação automática só via webhook autenticado.
router.post(
  "/invoices/:id/payments", requirePermission("billing:write"),
  validate({ params: id, body: z.object({ amountCents: z.number().int().positive(), method: z.string().max(30).optional(), reference: z.string().max(120).optional(), note: z.string().max(500).optional() }) }),
  async (req, res) => {
    const b = req.valid.body;
    const r = await svc.confirmPayment(req.valid.params.id, { amountCents: b.amountCents, method: b.method, providerRef: b.reference, note: b.note, provider: "manual", origin: "admin" }, actorOf(req));
    res.status(201).json(r);
  },
);
router.post("/invoices/:id/cancel", requirePermission("billing:write"), validate({ params: id, body: z.object({ reason: z.string().max(500).optional() }) }), async (req, res) =>
  res.json(await svc.cancelInvoice(req.valid.params.id, req.valid.body, actorOf(req))));
router.post("/sweep", requirePermission("billing:write"), async (req, res) => res.json(await svc.sweepDelinquency(actorOf(req))));

export default router;
