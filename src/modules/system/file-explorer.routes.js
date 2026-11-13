import { Router } from "express";
import { requirePermission } from "../../middleware/authenticate.js";
import { listExplorerDirectory, listExplorerRoots } from "./file-explorer.service.js";
import { AppError } from "../../shared/errors.js";

export const fileExplorerRoutes = Router();
// Nunca conceder a administradores comuns. O Superadmin é a única função autorizada.
fileExplorerRoutes.use(requirePermission("system:files"));
fileExplorerRoutes.use((req, _res, next) => {
  if (req.user?.role !== "superadmin") return next(new AppError(403, "FORBIDDEN", "Apenas o superadmin pode consultar os arquivos da VPS."));
  next();
});
fileExplorerRoutes.get("/roots", async (_req, res) => {
  res.set("Cache-Control", "no-store").json(await listExplorerRoots());
});
fileExplorerRoutes.get("/browse", async (req, res) => {
  if (typeof req.query.root !== "string" || (req.query.path !== undefined && typeof req.query.path !== "string")) {
    throw new AppError(400, "FILES_INVALID_PARAMS", "Informe uma pasta válida.");
  }
  res.set("Cache-Control", "no-store").json(await listExplorerDirectory({ rootId: req.query.root, relative: req.query.path || "" }));
});
