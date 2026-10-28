import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission, can } from "../../middleware/authenticate.js";
import { Plan } from "../../db/models/index.js";
import * as svc from "./license.service.js";
import { ensurePlan } from "./plan.service.js";

const router = Router();
const id = z.object({ id: z.string().uuid() });
const customer = z.object({ name: z.string().trim().min(1).max(160), email: z.string().email().max(200).optional(), phone: z.string().max(40).optional() });
const payment = z.object({ amountCents: z.number().int().positive(), method: z.string().max(30).optional(), reference: z.string().max(120).optional(), note: z.string().max(500).optional() });
const reason = z.object({ reason: z.string().trim().min(3).max(500).optional() });

router.get("/plans", requirePermission("licenses:read"), async (_req, res) => {
  await ensurePlan(1); // o plano de 1 mês (padrão) sempre existe e aparece na lista
  res.json({ data: await Plan.findAll({ order: [["durationMonths", "ASC"]] }) });
});

// Cria (ou devolve) o plano individual de N meses, 1 a 120.
router.post("/plans", requirePermission("licenses:write"), validate({ body: z.object({ months: z.number().int().min(1).max(120).default(1) }) }), async (req, res) =>
  res.status(201).json(await ensurePlan(req.valid.body.months)));

router.get(
  "/", requirePermission("licenses:read"),
  validate({ query: z.object({ ...pageQuery, q: z.string().max(100).optional(), status: z.enum(["pending", "active", "expired", "suspended", "blocked", "cancelled"]).optional(), planId: z.string().uuid().optional(), expiringInDays: z.coerce.number().int().min(1).max(365).optional() }) }),
  async (req, res) => res.json(await svc.listLicenses(req.valid.query)),
);

router.post(
  "/", requirePermission("licenses:write"),
  validate({ body: z.object({ planId: z.string().uuid(), customer: customer.optional(), startsAt: z.coerce.date().optional(), startOnFirstActivation: z.boolean().optional(), maxDevices: z.number().int().min(1).max(50).optional(), notes: z.string().max(2000).optional(), payment: payment.optional() }) }),
  async (req, res) => res.status(201).json(await svc.createLicense(req.valid.body, actorOf(req))),
);

router.get("/:id", requirePermission("licenses:read"), validate({ params: id }), async (req, res) => res.json(await svc.getLicense(req.valid.params.id)));

router.patch(
  "/:id", requirePermission("licenses:write"),
  validate({ params: id, body: z.object({ maxDevices: z.number().int().min(1).max(50).optional(), notes: z.string().max(2000).nullable().optional(), customer: customer.optional() }) }),
  async (req, res) => { await svc.updateLicense(req.valid.params.id, req.valid.body, actorOf(req)); res.json(await svc.getLicense(req.valid.params.id)); },
);

router.post(
  "/:id/renew", requirePermission("licenses:write"),
  validate({ params: id, body: z.object({ planId: z.string().uuid().optional(), payment: payment.optional() }) }),
  async (req, res) => { await svc.renewLicense(req.valid.params.id, req.valid.body, actorOf(req)); res.json(await svc.getLicense(req.valid.params.id)); },
);

for (const action of ["suspend", "block", "reactivate", "cancel"]) {
  router.post(`/:id/${action}`, requirePermission("licenses:write"), validate({ params: id, body: reason }), async (req, res) => {
    await svc.changeLicenseStatus(req.valid.params.id, action, { ...req.valid.body, force: can(req.user.role, "override") }, actorOf(req));
    res.json(await svc.getLicense(req.valid.params.id));
  });
}

export default router;
