import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { actorOf } from "../../shared/audit.js";
import { getPlatformSettings, savePlatformSettings, savePlatformSection } from "./platform-settings.service.js";
const mode = z.enum(["proxy", "redirect"]);
const schema = z.object({ trial: z.object({ enabled: z.boolean(), days: z.number().int().min(1).max(365) }).strict(), web: z.object({ autoHttps: z.boolean(), deliveryModes: z.object({ api: mode, live: mode, movie: mode, series: mode }).strict() }).strict() }).strict();
const router = Router();
router.use(requirePermission("override"));
router.get("/", async (_req, res) => res.set("Cache-Control", "no-store").json(await getPlatformSettings()));
router.put("/", validate({ body: schema }), async (req, res) => res.json(await savePlatformSettings(req.valid.body, actorOf(req))));
for (const section of ["trial", "web"]) router.put(`/${section}`, validate({ body: schema.shape[section] }), async (req,res) =>
  res.json(await savePlatformSection(section, req.valid.body, actorOf(req))));
export default router;
