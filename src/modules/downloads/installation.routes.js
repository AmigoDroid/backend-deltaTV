import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { AppError } from "../../shared/errors.js";
import { listDownloads } from "./download.service.js";

// Catálogo global publicado exclusivamente pela DeltaTV: leitura para sessões válidas
// nos três painéis. Não disponibiliza CRUD e nunca altera o escopo de /admin.
const router = Router();
router.get("/downloads", (req, res, next) => {
  if (!["superadmin", "admin", "support", "partner"].includes(req.user?.role))
    return next(new AppError(403, "FORBIDDEN", "O catálogo de aplicativos exige acesso ao painel."));
  res.set("Cache-Control", "private, no-store");
  next();
}, validate({ query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.json(await listDownloads(req.valid.query)));
export default router;
