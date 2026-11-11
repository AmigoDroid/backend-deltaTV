import { getServerHistory } from "./server-history.service.js";
import { Router } from "express";
import { z } from "zod";
import { requirePermission, requirePartnerRole } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { listServerHealth, getPartnerServerAlerts } from "./visibility.service.js";
import { providerQuality, recentQualityAlerts } from "./quality.service.js";

const query = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["healthy", "slow", "suspect", "down", "unknown", "disabled"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const adminServerMonitor = Router();
adminServerMonitor.get("/quality", requirePermission("partners:read"), async(req,res)=>
  res.set("Cache-Control","no-store").json({servers:await providerQuality(),alerts:await recentQualityAlerts()}));
adminServerMonitor.get("/:id/history", requirePermission("override"),
  validate({ params: z.object({ id: z.string().uuid() }), query: query.omit({ q: true }) }),
  async (req, res) => res.set("Cache-Control", "no-store").json(await getServerHistory(req.valid.params.id, req.valid.query)),
);
adminServerMonitor.get("/", requirePermission("partners:read"),
  validate({ query: query.extend({ partnerId: z.string().uuid().optional() }) }),
  async (req, res) => {
    res.set("Cache-Control", "no-store").json(await listServerHealth(req.valid.query));
  },
);

export const resellerServerMonitor = Router();
resellerServerMonitor.use(requirePartnerRole);
resellerServerMonitor.get("/quality",async(req,res)=>res.set("Cache-Control","no-store").json({
  servers:await providerQuality(req.user.partnerId),alerts:await recentQualityAlerts(req.user.partnerId)
}));
// Só leitura de telemetria recente, sem novas sondagens HTTP. Escopo vem do JWT.
resellerServerMonitor.get("/alerts", async (req, res) => {
  res.set("Cache-Control", "no-store").json(await getPartnerServerAlerts(req.user.partnerId));
});
resellerServerMonitor.get("/", validate({ query }), async (req, res) => {
  res.set("Cache-Control", "no-store").json(await listServerHealth({ ...req.valid.query, partnerId: req.user.partnerId }));
});
