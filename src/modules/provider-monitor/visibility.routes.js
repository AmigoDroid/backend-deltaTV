import { Router } from "express";
import { z } from "zod";
import { requirePermission, requirePartnerRole } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { listServerHealth } from "./visibility.service.js";

const query = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["healthy", "suspect", "down", "unknown", "disabled"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const adminServerMonitor = Router();
adminServerMonitor.get("/", requirePermission("partners:read"),
  validate({ query: query.extend({ partnerId: z.string().uuid().optional() }) }),
  async (req, res) => {
    res.set("Cache-Control", "no-store").json(await listServerHealth(req.valid.query));
  },
);

export const resellerServerMonitor = Router();
resellerServerMonitor.use(requirePartnerRole);
resellerServerMonitor.get("/", validate({ query }), async (req, res) => {
  res.set("Cache-Control", "no-store").json(await listServerHealth({ ...req.valid.query, partnerId: req.user.partnerId }));
});
