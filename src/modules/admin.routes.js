import { adminClientAppsRouter } from "./client-apps/client-app.routes.js";
import { emergencyRoutes } from "./provider-monitor/emergency.routes.js";
import { requirePermission } from "../middleware/authenticate.js";
import { Partner } from "../db/models/index.js";
import adminPaymentGateways from "./payment-gateways/admin.routes.js";
import workspaces from "./admin-workspaces/workspace.routes.js";
import { superadminFinance } from "./network-finance/finance.routes.js";
import { AppError } from "../shared/errors.js";
import servicePackages from "./service-packages/package.routes.js";
import globalConfig from "./platform-config/config.routes.js";
import {adminPortalSales} from "./partner-portal-sales/sales.routes.js";
import control from "./superadmin/control.routes.js";
import { adminNetwork } from "./distribution/network.routes.js";
import { adminMasterPixRouter } from "./distribution/master-pix.routes.js";
import { adminHelpRoutes } from "./help/help.routes.js";
import { adminRouter as whiteLabelApps } from "./white-label/white-label.routes.js";
import platformSettings from "./settings/platform-settings.routes.js";
import { Router } from "express";
import { systemRoutes } from "./system/system.routes.js";
import { adminServerMonitor } from "./provider-monitor/visibility.routes.js";
import { adminNotificationRoutes } from "./notifications/notification.routes.js";
import { authenticate } from "../middleware/authenticate.js";
import licenses from "./licenses/license.routes.js";
import partners from "./partners/partner.routes.js";
import servicePlansCatalog from "./service-plans/catalog.routes.js";
import devices from "./devices/device.routes.js";
import billing from "./billing/billing.routes.js";
import sources from "./sources/sources.routes.js";
import audit from "./audit/audit.routes.js";
import dashboard from "./dashboard/dashboard.routes.js";
import { adminRouter as pix } from "./pix/pix.routes.js";
import { adminRouter as credits } from "./credits/credit.routes.js";
import users from "./users/users.routes.js";
import clients from "./clients/client.admin.routes.js";
import { adminCommerce } from "./commerce/commerce.routes.js";
import mail from "./mail/mail.routes.js";
import { adminRouter as webAccess } from "./web/web.routes.js";
import { adminRouter as appDownloads } from "./downloads/download.routes.js";

// Tudo em /api/v1/admin exige autenticação; cada rota exige a permissão correspondente.
const router = Router();
router.use(authenticate);
// Limite fail-closed: APIs legadas usam queries globais. Um Admin de rede NUNCA
// pode chamá-las, mesmo que tente digitar a URL ou forçar parâmetros no navegador.
// Cada rota de /workspace aplica filtro de proprietário antes de ler/escrever.
router.use((req, _res, next) => {
  // Inclusive sessoes de selecao de conta do Admin sao operacionais.
  if (!['superadmin','support','admin'].includes(req.user?.role))
    throw new AppError(403, "ADMIN_PORTAL_DENIED", "Este token pertence ao portal operacional.");
  if (req.user?.role === "admin" && !/^\/workspace(?:\/|$)/.test(req.path))
    throw new AppError(403, "ADMIN_WORKSPACE_ONLY", "Acesse os recursos da sua rede. As configurações DeltaTV são reservadas.");
  next();
});
router.use("/workspace", workspaces);
// Superadmin pode atuar em qualquer parceria; nunca aceita um ID de fora da rota validada.
router.use('/partners/:id/emergency-dns',requirePermission('partners:write'),
  emergencyRoutes(async req=>{
    const p=await Partner.findByPk(req.params.id,{attributes:['id','status']});
    if(!p||p.status==='deleted')throw new AppError(404,'NOT_FOUND','Parceiro não encontrado.');
    return p.id;
  }));
router.use("/finance-networks",superadminFinance);
router.use("/payment-gateways",adminPaymentGateways);
router.use("/service-packages",servicePackages);
router.use("/global-config",globalConfig);
router.use("/portal-sales",adminPortalSales);
router.use("/control", control);
router.use("/platform-settings", platformSettings);
router.use("/notifications", adminNotificationRoutes);
router.use("/system", systemRoutes);
router.use("/licenses", licenses);
router.use("/partners", partners);
router.use("/network/master-pix", adminMasterPixRouter);
router.use("/network", adminNetwork);
router.use("/service-plans", servicePlansCatalog);
router.use("/client-apps", adminClientAppsRouter);
router.use("/server-monitor", adminServerMonitor);
router.use("/devices", devices);
router.use("/billing", billing);
router.use("/sources", sources);
router.use("/audit", audit);
router.use("/dashboard", dashboard);
router.use("/users", users);
router.use("/clients", clients);
router.use("/commerce", adminCommerce);
router.use("/pix", pix);
router.use("/credits", credits);
router.use("/mail", mail);
router.use("/web-access", webAccess);
router.use("/app-downloads", appDownloads);
router.use("/white-label", whiteLabelApps);
router.use("/help", adminHelpRoutes);
export default router;
