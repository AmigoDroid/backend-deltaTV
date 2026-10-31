import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import * as reseller from "../devices/reseller-devices.service.js";
import * as svc from "./download.service.js";

/**
 * Downloads de aplicativos — duas portas para o mesmo serviço:
 *   adminRouter    /api/v1/admin/app-downloads     admin: lista, cadastra, edita e exclui (downloads:read / downloads:write)
 *   partnerRouter  /api/v1/partner/app-downloads   revendedor: SOMENTE leitura
 */
const id = z.object({ id: z.string().uuid() });
const KINDS = ["app", "link"]; // app = aplicativo (versão + código do Downloader); link = link comum
const listQuery = z.object({ ...pageQuery, q: z.string().trim().max(60).optional(), kind: z.enum(KINDS).optional() });
const noStore = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

// Só http(s): o revendedor clica no link, então "javascript:" e afins nunca podem ser gravados.
const urlField = z.string().trim().min(1).max(2048)
  .refine((v) => { try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; } }, "Informe um link válido que comece com http:// ou https://.");
// Campos opcionais: vazio vira null (apaga o valor ao editar).
const optional = (schema) => z.union([z.literal("").transform(() => null), schema]).nullable().optional();
const fields = {
  kind: z.enum(KINDS),
  name: z.string().trim().min(1).max(120),
  version: optional(z.string().trim().min(1).max(40)),
  downloadUrl: urlField,
  downloaderCode: optional(z.string().trim().regex(/^\d{1,20}$/, "O código do Downloader deve ter apenas números.")),
};
const createBody = z.object({ ...fields, kind: fields.kind.default("app") });
const patchBody = z.object(fields).partial().refine((b) => Object.keys(b).length > 0, "Nada para alterar.");

/* ---------------------------------------------------------------- revendedor (somente leitura) */
export const partnerRouter = Router();
partnerRouter.use(noStore);
partnerRouter.use(async (req, _res, next) => {
  const partner = await reseller.loadReseller(req.user.partnerId);
  reseller.assertReseller(partner);
  next();
});
partnerRouter.get("/", validate({ query: listQuery }), async (req, res) => res.json(await svc.listDownloads(req.valid.query)));

/* ---------------------------------------------------------------- admin */
export const adminRouter = Router();
adminRouter.use(noStore);
adminRouter.get("/", requirePermission("downloads:read"), validate({ query: listQuery }), async (req, res) => res.json(await svc.listDownloads(req.valid.query)));
adminRouter.post("/", requirePermission("downloads:write"), validate({ body: createBody }), async (req, res) =>
  res.status(201).json(await svc.createDownload(req.valid.body, actorOf(req))));
adminRouter.patch("/:id", requirePermission("downloads:write"), validate({ params: id, body: patchBody }), async (req, res) =>
  res.json(await svc.updateDownload(req.valid.params.id, req.valid.body, actorOf(req))));
adminRouter.delete("/:id", requirePermission("downloads:write"), validate({ params: id }), async (req, res) => {
  await svc.deleteDownload(req.valid.params.id, actorOf(req));
  res.status(204).end();
});
