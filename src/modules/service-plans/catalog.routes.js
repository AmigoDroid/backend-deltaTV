import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { actorOf } from "../../shared/audit.js";
import { listCatalog,createCatalogPlan,updateCatalogPlan,removeCatalogPlan } from "./catalog.service.js";
const router=Router();
router.use(requirePermission("override"));
const key=z.string().regex(/^[a-z][a-z0-9_]{2,31}$/);
const params=z.object({key});
const fields=z.object({
  name:z.string().trim().min(3).max(120),
  description:z.string().trim().max(500).default(""),
  audience:z.enum(["reseller","content","both"]),
  monthlyPriceCents:z.number().int().min(0).max(100000000).nullable(),
  maxServers:z.number().int().min(1).max(8),
  autoFailover:z.boolean(),autoPriority:z.boolean(),
  emailAlerts:z.boolean(),detailedHistory:z.boolean(),
  sortOrder:z.number().int().min(0).max(9999),
}).strict();
// Zod v3: refine() retorna ZodEffects, que não suporta extend().
// Estenda o objeto antes de aplicar a regra cruzada em cada operação.
const validatePriority = (v) => v.autoFailover || !v.autoPriority;
const priorityError = { message: "Prioridade automática exige failover", path: ["autoPriority"] };
const createBody = fields.extend({ key }).refine(validatePriority, priorityError);
const updateBody = fields.extend({ active: z.boolean() }).refine(validatePriority, priorityError);
router.get("/",async(_req,res)=>res.set("Cache-Control","no-store").json({data:await listCatalog()}));
router.post("/",validate({body:createBody}),async(req,res)=>
  res.status(201).json(await createCatalogPlan(req.valid.body,actorOf(req))));
router.put("/:key",validate({params,body:updateBody}),async(req,res)=>
  res.json(await updateCatalogPlan(req.valid.params.key,req.valid.body,actorOf(req))));
router.delete("/:key",validate({params}),async(req,res)=>
  res.json(await removeCatalogPlan(req.valid.params.key,actorOf(req))));
export default router;
