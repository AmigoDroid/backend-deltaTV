import { Router } from "express";
import { requirePermission } from "../../middleware/authenticate.js";
import { readHostMetrics } from "./metrics.js";
import { fileExplorerRoutes } from "./file-explorer.routes.js";

export const systemRoutes = Router();
// Exclusivo do Superadmin: outros perfis não recebem esta permissão.
systemRoutes.get("/metrics", requirePermission("system:metrics"), (_req, res) => {
  res.set("Cache-Control", "no-store").json(readHostMetrics());
});

// Navegação somente leitura: acesso exclusivo ao Superadmin.
systemRoutes.use("/files", fileExplorerRoutes);
