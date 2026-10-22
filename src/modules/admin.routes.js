import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import licenses from "./licenses/license.routes.js";
import partners from "./partners/partner.routes.js";
import devices from "./devices/device.routes.js";
import billing from "./billing/billing.routes.js";
import sources from "./sources/sources.routes.js";
import audit from "./audit/audit.routes.js";
import dashboard from "./dashboard/dashboard.routes.js";
import users from "./users/users.routes.js";

// Tudo em /api/v1/admin exige autenticação; cada rota exige a permissão correspondente.
const router = Router();
router.use(authenticate);
router.use("/licenses", licenses);
router.use("/partners", partners);
router.use("/devices", devices);
router.use("/billing", billing);
router.use("/sources", sources);
router.use("/audit", audit);
router.use("/dashboard", dashboard);
router.use("/users", users);
export default router;
