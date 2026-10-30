import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { AppError } from "../../shared/errors.js";
import {
  activationIpLimiter,
  activationMacLimiter,
  partnerCodeIpLimiter,
  partnerCredLimiter,
  refreshLimiter,
  deviceRegistrationLimiter,
  registerMacLimiter,
  pairingPollLimiter,
  deviceKeyIssueLimiter,
  listUrlIpLimiter,
  listUrlMacLimiter,
  pixSiteCreateIpLimiter,
  pixSiteCreateMacLimiter,
  pixSiteReadLimiter,
} from "../../middleware/security.js";
import { requireDevice } from "../access/access.middleware.js";
import { refreshSession, playTokenFor } from "../access/access.service.js";
import { env } from "../../config/env.js";
import { xtreamConfigFor, hasXtreamSource } from "../xtream/xtream.service.js";
import * as deviceAccess from "../devices/device-access.service.js";
import * as svc from "./activation.service.js";
import * as deviceConfig from "../devices/registration.service.js";
import { addListByUrl } from "../devices/playlist-by-url.service.js";
import * as pix from "../pix/pix.service.js";
import { clientRouter as webClientRoutes } from "../web/web.routes.js";
import { sameInstallation, VIRTUAL_INSTALLATION_PATTERN, VIRTUAL_INSTALLATION_HINT } from "../devices/device-identity.js";

/** API pública para os aplicativos/frontends clientes (prefixo /api/v1/client). */
const router = Router();

// Compatibilidade com o app Roku: chaves de objeto em BrightScript perdem a caixa ({installationId:x} sai como "installationid").
// Recupera o camelCase esperado quando só a versão minúscula veio. Só estas chaves, só em corpos JSON simples.
const CAMEL_KEYS = [
  "installationId",
  "refreshToken",
  "registrationToken",
  "idempotencyKey",
];
router.use((req, _res, next) => {
  const b = req.body;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    for (const k of CAMEL_KEYS) {
      const lower = k.toLowerCase();
      if (b[k] === undefined && b[lower] !== undefined) {
        b[k] = b[lower];
        delete b[lower];
      }
    }
  }
  next();
});
const meta = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const installationId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/, "installationId inválido")
  .optional();
const mac = z.string().min(11).max(20);
const idem = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,64}$/)
  .optional();
const licenseBody = z.object({
  code: z.string().min(8).max(64),
  mac,
  installationId,
  idempotencyKey: idem,
});
// Parceria: código curto (4–12 letras/números) + usuário e senha do provedor IPTV.
const partnerBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,12}$/, "Código inválido"),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  mac,
  installationId,
  idempotencyKey: idem,
});

const kindOf = (a) => (a.licenseId ? "license" : "partner");
const configurationStatusOf = (activation, decision) => {
  if (activation.status === "revoked") return "deactivated";
  if (activation.status === "blocked") return "disabled";
  if (!decision.allowed)
    return /EXPIRED/.test(decision.code ?? "") ? "expired" : "disabled";
  if (activation.partnerId && !activation.providerId) return "error";
  // Mesmo critério de registration.service: provedor desativado = "error" (em /xtream seria 503).
  if (activation.partnerId && activation.PartnerProvider && activation.PartnerProvider.status !== "active")
    return "error";
  if (activation.partnerId && activation.providerId)
    return "configured_partner";
  if (activation.licenseId && activation.playlistUrlEnc)
    return "configured_playlist";
  return "awaiting_configuration";
};
const activationResponse = (r) => ({
  activationId: r.activation.id,
  kind: kindOf(r.activation),
  status: "active",
  configurationStatus: configurationStatusOf(r.activation, { allowed: true }),
  expiresAt: r.expiresAt,
  reused: r.reused ?? false,
  tokens: {
    accessToken: r.session.accessToken,
    refreshToken: r.session.refreshToken,
    expiresIn: r.session.expiresIn,
  },
});

// Player Web: login pelo código AB123456 gerado pelo revendedor (POST /api/v1/client/web/login).
router.use("/web", webClientRoutes);

router.post(
  "/activate/license",
  activationIpLimiter,
  activationMacLimiter,
  validate({ body: licenseBody }),
  async (req, res) => {
    const r = await svc.activateLicense({ ...req.valid.body, meta: meta(req) });
    res.status(r.reused ? 200 : 201).json(activationResponse(r));
  },
);

router.post(
  "/activate/partner",
  activationIpLimiter,
  activationMacLimiter,
  partnerCodeIpLimiter,
  partnerCredLimiter,
  validate({ body: partnerBody }),
  async (req, res) => {
    const r = await svc.activatePartner({ ...req.valid.body, meta: meta(req) });
    res.status(r.reused ? 200 : 201).json(activationResponse(r));
  },
);

// Migração de dispositivos legados (ativação pendente de "claim").
router.post(
  "/claim",
  activationIpLimiter,
  activationMacLimiter,
  validate({
    body: z.object({
      mac: z.string().min(11).max(20),
      installationId: z.string().regex(/^[A-Za-z0-9._:-]{8,100}$/),
    }),
  }),
  async (req, res) =>
    res.json(
      activationResponse(
        await svc.claimLegacy({ ...req.valid.body, meta: meta(req) }),
      ),
    ),
);

router.post(
  "/session/refresh",
  refreshLimiter,
  validate({
    body: z.object({
      refreshToken: z.string().min(20).max(200),
      installationId,
    }),
  }),
  async (req, res) => {
    const r = await refreshSession(req.valid.body.refreshToken, req.valid.body);
    res.json({
      allowed: true,
      expiresAt: r.decision.expiresAt,
      tokens: r.tokens,
    });
  },
);

router.post(
  "/register",
  deviceRegistrationLimiter,
  registerMacLimiter,
  validate({
    body: z.object({
      mac: z.string().min(11).max(20),
      installationId: z.string().regex(VIRTUAL_INSTALLATION_PATTERN, VIRTUAL_INSTALLATION_HINT),
    }),
  }),
  async (req, res) =>
    res.status(200).json(await deviceConfig.registerDevice(req.valid.body)),
);
router.post(
  "/register/status",
  pairingPollLimiter,
  validate({
    body: z.object({
      mac: z.string().min(11).max(20),
      installationId: z.string().regex(VIRTUAL_INSTALLATION_PATTERN, VIRTUAL_INSTALLATION_HINT),
      registrationToken: z.string().min(40).max(100),
    }),
  }),
  async (req, res) =>
    res.json(
      await deviceConfig.pollRegistration({
        ...req.valid.body,
        meta: meta(req),
      }),
    ),
);
// (Removida) POST /pairing/configure: a página do QR não configura mais nada. Ela só mostra o MAC para o revendedor
// copiar e editar o dispositivo, autenticado, em /api/v1/partner/mac/* (com auditoria de quem alterou).

// Status/validação: respondem 200 com a decisão (o app decide a UI); recursos protegidos respondem 403.
const statusOf = (req) => {
  const { activation, decision } = req.device;
  return {
    activationId: activation.id,
    configurationVersion: `${activation.updatedAt ? new Date(activation.updatedAt).toISOString() : ""}|${activation.PartnerProvider?.updatedAt ? new Date(activation.PartnerProvider.updatedAt).toISOString() : ""}`,
    mac: activation.mac,
    kind: kindOf(activation),
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message,
    expiresAt: decision.expiresAt,
    configurationStatus: configurationStatusOf(activation, decision),
    listName: activation.playlistName ?? null,
  };
};
router.get("/status", requireDevice("device", { enforce: false }), (req, res) =>
  res.json(statusOf(req)),
);
router.post(
  "/validate",
  requireDevice("device", { enforce: false }),
  validate({ body: z.object({ installationId }) }),
  (req, res) => {
    const { activation } = req.device;
    if (
      activation.installationId &&
      req.valid.body.installationId &&
      !sameInstallation(activation.installationId, req.valid.body.installationId)
    ) {
      throw new AppError(
        403,
        "INSTALLATION_MISMATCH",
        "Instalação não reconhecida.",
      );
    }
    res.json(statusOf(req));
  },
);

// Um MAC pode estar associado a vários parceiros: cada um é uma "lista" (ativação) com as suas próprias sessões.
// Lista as listas vivas deste aparelho (a sessão que chama pode ser de qualquer uma delas, mesmo bloqueada/expirada)...
router.get("/lists", requireDevice("device", { enforce: false }), async (req, res) => {
  res.set("Cache-Control", "no-store").json({
    currentActivationId: req.device.activation.id,
    lists: await deviceConfig.listsOfDevice(req.device.activation.deviceId),
  });
});
// ...e emite a sessão de outra lista do mesmo aparelho (ex.: um parceiro adicionado depois pelo painel).
router.post(
  "/lists/:activationId/session",
  refreshLimiter,
  requireDevice("device", { enforce: false }),
  validate({ params: z.object({ activationId: z.string().uuid() }), body: z.object({ installationId }) }),
  async (req, res) => {
    const r = await svc.issueSiblingSession({
      currentActivation: req.device.activation,
      targetActivationId: req.valid.params.activationId,
      installationId: req.valid.body.installationId,
      meta: meta(req),
    });
    res.set("Cache-Control", "no-store").json({
      activationId: r.activation.id,
      kind: kindOf(r.activation),
      allowed: true,
      expiresAt: r.expiresAt,
      tokens: { accessToken: r.session.accessToken, refreshToken: r.session.refreshToken, expiresIn: r.session.expiresIn },
    });
  },
);

// O app da TV fala direto com a API Xtream do provedor: há uma única "lista" por dispositivo, identificada por "me".
router.get("/resources", requireDevice(), async (req, res) => {
  const { activation } = req.device;
  const sources = hasXtreamSource(activation)
    ? [{ id: "me", name: activation.playlistName || "Minha lista", kind: "xtream" }]
    : [];
  res.json({ sources, expiresAt: req.device.decision.expiresAt });
});

// Conexão Xtream (painel + usuário + senha) do dispositivo autorizado. Sessão válida e licença ativa são
// revalidadas no banco a cada chamada (requireDevice); a TV chama de novo a cada abertura do app.
router.get("/xtream", requireDevice(), async (req, res) => {
  res.set("Cache-Control", "no-store").json({
    ...(await xtreamConfigFor(req.device.activation, { sessionId: req.device.session.id })),
    expiresAt: req.device.decision.expiresAt,
  });
});

// Chave de 6 dígitos para o acesso por MAC + chave (/api/v1/device-access). Exige sessão válida da TV: só quem já tem acesso gera a chave.
router.post(
  "/device-key",
  requireDevice(),
  deviceKeyIssueLimiter,
  async (req, res) => {
    res.set("Cache-Control", "no-store").json(
      await deviceAccess.issueDeviceKey({
        deviceId: req.device.activation.deviceId,
        ip: req.ip,
      }),
    );
  },
);

router.post("/play-token", requireDevice(), (req, res) => {
  const { activation, session } = req.device;
  res.json({
    playToken: playTokenFor(activation.id, session.id),
    expiresIn: env.playTokenTtl,
  });
});

router.post(
  "/configure/playlist",
  requireDevice(),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(160),
      url: z.string().trim().min(1).max(2048),
    }),
  }),
  async (req, res) => {
    const result = await deviceConfig.savePersonalPlaylist(
      req.device.activation.id,
      req.valid.body,
      { type: "device", id: req.device.activation.id, ip: req.ip },
    );
    res.json({ ...result, configurationStatus: "configured_playlist" });
  },
);

// Cadastro pelo site (rota /upload/playlist do QR da TV): MAC + nome + link M3U completo. Público (sem sessão da TV): o servidor só
// extrai servidor/usuário/senha do link e NÃO baixa a lista. Sem licença o cadastro é aceito, mas só passa a valer quando houver uma.
router.post(
  "/playlist/by-url",
  listUrlIpLimiter,
  listUrlMacLimiter,
  validate({
    body: z.object({
      mac,
      name: z.string().trim().min(1).max(160),
      url: z.string().trim().min(1).max(2048),
    }),
  }),
  async (req, res) => {
    res.set("Cache-Control", "no-store").json(await addListByUrl({ ...req.valid.body, ip: req.ip }));
  },
);

// Compra da licença anual pelo SITE, paga via Pix (público, sem sessão da TV). O preço e o produto vêm do servidor; o cliente só informa
// MAC + e-mail. Ao confirmar o pagamento (webhook ou consulta), o servidor cria/renova a licença e ativa no MAC.
router.get("/pix/license/config", pixSiteReadLimiter, async (_req, res) => {
  res.set("Cache-Control", "no-store").json(await pix.licenseOffer());
});
router.post(
  "/pix/license",
  pixSiteCreateIpLimiter,
  pixSiteCreateMacLimiter,
  validate({ body: z.object({ mac, email: z.string().trim().toLowerCase().email().max(200) }) }),
  async (req, res) => {
    const charge = await pix.createLicenseCharge({ ...req.valid.body, ip: req.ip });
    res.status(201).set("Cache-Control", "no-store").json(pix.chargeView(charge));
  },
);
router.get(
  "/pix/license/:id",
  pixSiteReadLimiter,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  async (req, res) => {
    res.set("Cache-Control", "no-store").json(pix.chargeView(await pix.getLicenseCharge(req.valid.params.id)));
  },
);

router.post(
  "/deactivate",
  requireDevice("device", { enforce: false }),
  async (req, res) => {
    await svc.deactivateSelf(req.device.activation.id, meta(req));
    res.status(204).end();
  },
);

export default router;
