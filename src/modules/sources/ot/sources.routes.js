import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import * as svc from "./sources.service.js";

const router = Router();
const id = z.object({ id: z.string().uuid() });
const child = z.object({ id: z.string().uuid(), childId: z.string().uuid() });

const signing = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("hmac-query"), secret: z.string().min(16).max(200).optional(), ttlSeconds: z.number().int().min(5).max(3600).optional(), tokenParam: z.string().regex(/^\w{1,20}$/).optional(), expiresParam: z.string().regex(/^\w{1,20}$/).optional() }),
  z.object({ type: z.literal("nginx-secure-link"), secret: z.string().min(16).max(200).optional(), ttlSeconds: z.number().int().min(5).max(3600).optional() }),
]);
const sourceBase = z.object({
  name: z.string().trim().min(2).max(160),
  scope: z.enum(["global", "partner"]).default("partner"),
  deliveryMode: z.enum(["redirect", "proxy"]).default("redirect"),
  signing: signing.optional(),
  notes: z.string().max(2000).optional(),
});

router.get("/", requirePermission("sources:read"), validate({ query: z.object({ ...pageQuery, q: z.string().max(100).optional(), scope: z.enum(["global", "partner"]).optional(), status: z.enum(["active", "disabled"]).optional() }) }), async (req, res) => res.json(await svc.listSources(req.valid.query)));
router.post(
  "/", requirePermission("sources:write"),
  validate({ body: sourceBase.extend({ kind: z.enum(["playlist", "catalog"]).default("playlist"), url: z.string().max(2000).optional() }).refine((v) => v.kind !== "playlist" || v.url, { message: "Informe a URL da playlist", path: ["url"] }) }),
  async (req, res) => res.status(201).json(await svc.createSource(req.valid.body, actorOf(req))),
);
router.get("/:id", requirePermission("sources:read"), validate({ params: id }), async (req, res) => res.json(await svc.getSource(req.valid.params.id)));
router.patch("/:id", requirePermission("sources:write"), validate({ params: id, body: sourceBase.partial().extend({ url: z.string().max(2000).optional(), status: z.enum(["active", "disabled"]).optional() }) }), async (req, res) =>
  res.json(await svc.updateSource(req.valid.params.id, req.valid.body, actorOf(req))));
router.delete("/:id", requirePermission("sources:write"), validate({ params: id }), async (req, res) => { await svc.deleteSource(req.valid.params.id, actorOf(req)); res.status(204).end(); });
router.put("/:id/partners", requirePermission("sources:write"), validate({ params: id, body: z.object({ partnerIds: z.array(z.string().uuid()).max(500) }) }), async (req, res) => {
  await svc.setSourcePartners(req.valid.params.id, req.valid.body.partnerIds, actorOf(req));
  res.json(await svc.getSource(req.valid.params.id));
});

const category = z.object({ name: z.string().trim().min(1).max(160), sortOrder: z.number().int().min(0).max(100000).optional() });
router.get("/:id/categories", requirePermission("sources:read"), validate({ params: id }), async (req, res) => res.json({ data: await svc.listCategories(req.valid.params.id) }));
router.post("/:id/categories", requirePermission("sources:write"), validate({ params: id, body: category }), async (req, res) => res.status(201).json(await svc.createCategory(req.valid.params.id, req.valid.body)));
router.patch("/:id/categories/:childId", requirePermission("sources:write"), validate({ params: child, body: category.partial() }), async (req, res) => res.json(await svc.updateCategory(req.valid.params.id, req.valid.params.childId, req.valid.body)));
router.delete("/:id/categories/:childId", requirePermission("sources:write"), validate({ params: child }), async (req, res) => { await svc.deleteCategory(req.valid.params.id, req.valid.params.childId); res.status(204).end(); });

const channel = z.object({
  name: z.string().trim().min(1).max(200), streamUrl: z.string().max(2000),
  kind: z.enum(["live", "movie", "series"]).default("live"), categoryId: z.string().uuid().nullable().optional(),
  externalId: z.string().max(120).nullable().optional(), logoUrl: z.string().url().max(2000).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(), sortOrder: z.number().int().min(0).max(100000).optional(),
});
router.get("/:id/channels", requirePermission("sources:read"), validate({ params: id, query: z.object({ ...pageQuery, q: z.string().max(100).optional() }) }), async (req, res) => res.json(await svc.listChannels(req.valid.params.id, req.valid.query)));
router.post("/:id/channels", requirePermission("sources:write"), validate({ params: id, body: channel }), async (req, res) => res.status(201).json(await svc.createChannel(req.valid.params.id, req.valid.body, actorOf(req))));
router.patch("/:id/channels/:childId", requirePermission("sources:write"), validate({ params: child, body: channel.partial() }), async (req, res) => res.json(await svc.updateChannel(req.valid.params.id, req.valid.params.childId, req.valid.body, actorOf(req))));
router.delete("/:id/channels/:childId", requirePermission("sources:write"), validate({ params: child }), async (req, res) => { await svc.deleteChannel(req.valid.params.id, req.valid.params.childId, actorOf(req)); res.status(204).end(); });

export default router;
