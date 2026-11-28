import { Router } from "express";
import { requirePermission } from "../../middleware/authenticate.js";
import { listCatalog } from "./catalog.service.js";
const router=Router();
router.use(requirePermission("override"));
router.get("/",async(_req,res)=>res.set("Cache-Control","no-store").json({data:await listCatalog()}));
router.use((_req,res)=>res.status(410).json({code:"USE_SERVICE_PACKAGES",message:"Gerencie o catálogo em Pacotes de serviço."}));
export default router;
