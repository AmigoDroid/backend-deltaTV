import { Op } from "sequelize";
import {
  sequelize, Activation, Device, DevicePairingToken, Partner, PartnerCode, PartnerProvider,
} from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { normalizeMac } from "../../shared/mac.js";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../../shared/crypto.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { checkActivation, denialError, issueSession, overdueSinceFor, enforceSessionCap } from "../access/access.service.js";
import { activateLicense, activatePrepared, preparePartnerActivation } from "../activations/activation.service.js";
import { evaluateAccess } from "../access/access.policy.js";
import { pickPrimaryList } from "./device-lists.js";
import { parseVirtualInstallationId, sameInstallation, VIRTUAL_INSTALLATION_HINT } from "./device-identity.js";
import { dropMirrorAuth } from "../mirror/mirror.cache.js";

const live = { [Op.ne]: "revoked" };

function statusName(activation, decision) {
  if (!activation) return "awaiting_configuration";
  if (activation.status === "blocked") return "disabled";
  if (activation.status === "revoked") return "deactivated";
  if (activation.partnerId && (!activation.PartnerProvider || activation.PartnerProvider.status !== "active")) return "error";
  if (!decision.allowed) {
    return /EXPIRED/.test(decision.code ?? "") ? "expired" : "disabled";
  }
  if (activation.partnerId && activation.providerId) return "configured_partner";
  if (activation.licenseId && activation.playlistUrlEnc) return "configured_playlist";
  return "awaiting_configuration";
}

/** Resumo de UMA ativação (uma "lista" do dispositivo). Reavalia o acesso no banco. */
async function summarizeActivation(activationId) {
  const { activation, decision } = await checkActivation(activationId);
  const status = statusName(activation, decision);
  return {
    activationId: activation.id,
    kind: activation.partnerId ? "partner" : "license",
    status,
    configurationStatus: status,
    configured: status === "configured_partner" || status === "configured_playlist",
    mode: status === "configured_partner" ? "partner" : status === "configured_playlist" ? "playlist" : null,
    listName: activation.playlistName ?? activation.PartnerProvider?.name ?? null,
    allowed: !!decision.allowed,
    code: status === "error" ? "PROVIDER_UNAVAILABLE" : decision.code,
    message: status === "error" ? "Serviço indisponível. Contate seu fornecedor." : decision.message,
    expiresAt: decision.expiresAt ?? null,
  };
}

/** Todas as listas (ativações vivas) do dispositivo, da mais recente para a mais antiga. */
export async function listsOfDevice(deviceId) {
  const rows = await Activation.findAll({
    where: { deviceId, status: live }, attributes: ["id"], order: [["activatedAt", "DESC"], ["id", "ASC"]],
  });
  return Promise.all(rows.map((r) => summarizeActivation(r.id)));
}

/**
 * Estado do dispositivo. Os campos de nível superior descrevem a lista PRINCIPAL (compatível com quem só conhece uma lista);
 * `activations` traz todas as listas vivas — um MAC pode estar associado a vários parceiros.
 */
async function stateOf(device) {
  const lists = await listsOfDevice(device.id);
  let primary = pickPrimaryList(lists);
  if (!primary) {
    // Sem vínculo vivo: mostra a ativação revogada mais recente (estado "deactivated"), se houver.
    const last = await Activation.findOne({ where: { deviceId: device.id }, attributes: ["id"], order: [["updatedAt", "DESC"]] });
    primary = last ? await summarizeActivation(last.id) : null;
  }
  return {
    deviceId: device.id,
    mac: device.mac,
    installationId: device.lastInstallationId,
    status: primary?.status ?? "awaiting_configuration",
    configurationStatus: primary?.status ?? "awaiting_configuration",
    configured: primary?.configured ?? false,
    activationId: primary?.activationId ?? null,
    mode: primary?.mode ?? null,
    listName: primary?.listName ?? null,
    allowed: primary?.allowed ?? false,
    code: primary?.code ?? "AWAITING_CONFIGURATION",
    message: primary?.message ?? "Configure a lista para continuar.",
    expiresAt: primary?.expiresAt ?? null,
    activations: lists,
  };
}

/** Valida MAC + installationId de um aparelho de MAC virtual (roku, rokutv, androidtv, samsungtv, lgtv) e devolve a plataforma. */
export function normalizeVirtualRegistration(macInput, installationId) {
  const mac = normalizeMac(macInput);
  if (!mac) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");
  const parsed = parseVirtualInstallationId(installationId);
  if (!parsed || parsed.compact !== mac.replaceAll(":", "")) {
    throw new AppError(400, "INSTALLATION_ID_MISMATCH", `O identificador não confere com o MAC. ${VIRTUAL_INSTALLATION_HINT}`);
  }
  return { mac, installationId, platform: parsed.platform };
}
/** Nome antigo, mantido por compatibilidade. */
export const normalizeRokuRegistration = normalizeVirtualRegistration;

/**
 * Recuperação após reinstalação/reset (decisão D1/D2, docs/03):
 *  mac_lookup (padrão)  — o MAC reconhece a TV; havendo ativação viva, o servidor reaproveita o fluxo de registro (a TV conclui pelo
 *                         /register/status e recebe uma sessão nova). Quem souber o MAC pode obter a sessão: risco aceito, mitigado por
 *                         limite de sessões, limite de tentativas por MAC, resposta mínima e auditoria.
 *  proof_required       — exige QR/chave mesmo com o MAC reconhecido (comportamento anterior: "session_required").
 */
const recoveryMode = () => (process.env.DEVICE_RECOVERY_MODE === "proof_required" ? "proof_required" : "mac_lookup");

/** Plataforma/app do aparelho conforme o prefixo do installationId (o MAC continua sendo a identidade). */
const platformFields = ({ platform, mac }) => ({
  platform, appId: `delta-tv-${platform}`, identifierType: "virtual_mac", deviceKey: `${platform}:${mac}`,
});

export async function registerDevice({ mac: macInput, installationId }) {
  const normalized = normalizeVirtualRegistration(macInput, installationId);
  const pairToken = randomToken(32);
  const registrationToken = randomToken(32);
  const expiresAt = new Date(Date.now() + env.pairingTokenTtl * 1000);

  const result = await sequelize.transaction(async (transaction) => {
    const [device] = await Device.findOrCreate({
      where: { mac: normalized.mac },
      defaults: { mac: normalized.mac, ...platformFields(normalized) },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    // Um MAC pode ter várias ativações vivas (uma por parceiro): nenhuma delas pode pertencer a outra instalação.
    const actives = await Activation.findAll({
      where: { deviceId: device.id, status: live },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (actives.some((a) => a.installationId && !sameInstallation(a.installationId, normalized.installationId))) {
      throw new AppError(409, "INSTALLATION_MISMATCH", "Este dispositivo pertence a outra instalação.");
    }
    await device.update({ lastInstallationId: normalized.installationId, lastSeenAt: new Date(), ...platformFields(normalized) }, { transaction });
    const active = actives.length > 0;
    const recoverable = active && recoveryMode() === "mac_lookup";
    let pairing = null;
    if (!active || recoverable) {
      pairing = await DevicePairingToken.findOne({
        where: {
          deviceId: device.id,
          usedAt: null,
          registrationUsedAt: null,
          expiresAt: { [Op.gt]: new Date() },
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!pairing) {
        await DevicePairingToken.update(
          { usedAt: new Date(), registrationUsedAt: new Date() },
          { where: { deviceId: device.id, usedAt: null }, transaction },
        );
        pairing = await DevicePairingToken.create({
          deviceId: device.id,
          tokenHash: sha256(pairToken),
          tokenEnc: encryptSecret(pairToken),
          registrationHash: sha256(registrationToken),
          registrationEnc: encryptSecret(registrationToken),
          expiresAt,
        }, { transaction });
      }
    }
    await audit({
      actor: { type: "device", id: device.id },
      action: "device.register",
      entityType: "device",
      entityId: device.id,
      metadata: { mac: device.mac, installationId: normalized.installationId, pairingId: pairing?.id ?? null, recoverable, liveActivations: actives.length },
      transaction,
    });
    return { device, pairing, recoverable };
  });

  if (!result.pairing) {
    return {
      registered: true,
      status: "session_required",
      message: "Use a sessão autenticada deste dispositivo para consultar seu estado.",
      pairing: null,
    };
  }
  const pairingOut = {
    url: `${env.publicBaseUrl}/pair#${decryptSecret(result.pairing.tokenEnc)}`,
    expiresAt: result.pairing.expiresAt,
    registrationToken: decryptSecret(result.pairing.registrationEnc),
  };
  if (result.recoverable) {
    // Resposta mínima: quem só conhece o MAC não vê lista, parceiro nem estado da licença. A sessão sai no /register/status.
    return { registered: true, status: "awaiting_configuration", configured: false, message: "Restaurando o acesso deste dispositivo.", pairing: pairingOut };
  }
  const state = await stateOf(result.device);
  return { ...state, pairing: pairingOut };
}

/**
 * Resolve o token do QR para o MAC do aparelho que o exibiu. Não consome o token e não concede nada:
 * serve apenas para a página pública mostrar o MAC (o MAC vem do servidor, nunca da URL).
 * Falhas (inexistente, expirado, usado) respondem igual, sem revelar o motivo.
 */
export async function resolvePairing(token) {
  const pairing = await DevicePairingToken.findOne({
    where: { tokenHash: sha256(token), usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    include: [Device],
  });
  if (!pairing?.Device?.mac) {
    throw new AppError(404, "PAIRING_NOT_FOUND", "QR Code inválido ou expirado. Gere um novo na TV.");
  }
  return { mac: pairing.Device.mac, expiresAt: pairing.expiresAt };
}

export async function savePersonalPlaylist(activationId, { name, url }, actor) {
  const publicUrl = await assertPublicUrl(url);
  const urlEnc = encryptSecret(publicUrl.href);
  const activation = await sequelize.transaction(async (transaction) => {
    const row = await Activation.findByPk(activationId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || row.status === "revoked") throw notFound("Ativação");
    if (!row.licenseId) {
      throw new AppError(403, "LICENSE_REQUIRED", "Uma licença Delta ativa é necessária para usar uma lista sem parceria.");
    }
    const { decision } = await checkActivation(row.id, { transaction });
    if (!decision.allowed) throw denialError(decision);
    await row.update({ playlistName: name, playlistUrlEnc: urlEnc }, { transaction });
    await audit({
      actor,
      action: "device.playlist.configure",
      entityType: "activation",
      entityId: row.id,
      metadata: { mac: row.mac, listName: name, host: publicUrl.hostname },
      transaction,
    });
    return row;
  });
  dropMirrorAuth(activation.id);
  return { activationId: activation.id, mode: "playlist", listName: activation.playlistName };
}

export async function pollRegistration({ mac: macInput, installationId, registrationToken, meta }) {
  const normalized = normalizeVirtualRegistration(macInput, installationId);
  const pairing = await DevicePairingToken.findOne({
    where: {
      registrationHash: sha256(registrationToken),
      expiresAt: { [Op.gt]: new Date() },
    },
    include: [Device],
  });
  if (!pairing || pairing.Device.mac !== normalized.mac || !sameInstallation(pairing.Device.lastInstallationId, normalized.installationId)) {
    throw new AppError(403, "REGISTRATION_TOKEN_INVALID", "Registro não reconhecido. Gere um novo QR Code no dispositivo.");
  }
  if (pairing.registrationUsedAt) {
    throw new AppError(409, "REGISTRATION_TOKEN_USED", "O registro já foi concluído neste dispositivo.");
  }
  const state = await stateOf(pairing.Device);
  if (!state.activationId || !state.allowed) return state;

  return sequelize.transaction(async (transaction) => {
    const locked = await DevicePairingToken.findByPk(pairing.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.registrationUsedAt || locked.expiresAt <= new Date()) {
      throw new AppError(409, "REGISTRATION_TOKEN_USED", "O registro já foi concluído neste dispositivo.");
    }
    // Uma sessão por lista liberada (um MAC pode ter vários parceiros). Listas bloqueadas/expiradas não recebem sessão.
    const allowedIds = state.activations.filter((l) => l.allowed).map((l) => l.activationId);
    const activations = await Activation.findAll({ where: { id: { [Op.in]: allowedIds }, status: live }, transaction });
    // A lista deixou de estar liberada entre a consulta e a trava: não consome o registro.
    if (activations.length === 0) return state;
    await locked.update({ registrationUsedAt: new Date() }, { transaction });
    const sessions = new Map();
    const recoveredIds = [];
    for (const activation of activations) {
      // Ativação anterior ao pareamento = TV que já tinha acesso e foi reinstalada/resetada (recuperação).
      const recovered = activation.createdAt < locked.createdAt;
      if (recovered) {
        await enforceSessionCap(activation.id, transaction);
        recoveredIds.push(activation.id);
      }
      sessions.set(String(activation.id), await issueSession(activation, meta, transaction));
    }
    if (recoveredIds.length) {
      await pairing.Device.update({ installationChangedAt: new Date() }, { transaction });
      await audit({
        actor: { type: "device", id: pairing.Device.id }, action: "device.recovered", entityType: "device", entityId: pairing.Device.id,
        metadata: { mac: pairing.Device.mac, activationId: recoveredIds[0], activationIds: recoveredIds }, transaction,
      });
    }
    const tokensOf = (id) => {
      const session = sessions.get(String(id));
      return session ? { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn } : null;
    };
    // Principal: mantém o formato antigo (`tokens` da lista principal). Se ela não recebeu sessão, usa a primeira que recebeu.
    const primaryId = sessions.has(String(state.activationId)) ? state.activationId : [...sessions.keys()][0];
    return {
      ...state,
      activationId: primaryId,
      tokens: tokensOf(primaryId),
      activations: state.activations.map((l) => ({ ...l, tokens: tokensOf(l.activationId) })),
    };
  });
}

export async function findRegisteredDevices({ q, page = 1, pageSize = 20 }) {
  const where = q
    ? {
      [Op.or]: [
        { mac: normalizeMac(q) ?? { [Op.iLike]: `%${q.replace(/[^0-9A-Fa-f:.-]/g, "")}%` } },
        { lastInstallationId: { [Op.iLike]: `%${q}%` } },
      ],
    }
    : {};
  const { rows, count } = await Device.findAndCountAll({
    where,
    order: [["updatedAt", "DESC"]],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  return {
    data: await Promise.all(rows.map((device) => stateOf(device))),
    pagination: { page, pageSize, total: count, pages: Math.ceil(count / pageSize) },
  };
}

export async function registeredDeviceById(deviceId) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  return stateOf(device);
}

/**
 * Configura uma lista do dispositivo pelo painel (admin, revendedor por MAC ou acesso por chave da TV).
 *
 * Um MAC pode ter VÁRIOS parceiros: informar código/usuário/senha de um parceiro
 *  - que ainda não está neste MAC  -> ADICIONA uma ativação para ele (as dos outros parceiros ficam intactas);
 *  - que já está neste MAC         -> atualiza as credenciais/provedor da ativação DELE.
 * Para trocar de parceiro, remova a lista do antigo (remove-list/revoke) e adicione o novo.
 * Modo "playlist" (lista própria) usa a ativação por licença do MAC, que é independente das ativações por parceiro.
 */
export async function configureDeviceByAdmin(deviceId, input, actor) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  if (!input.confirm) {
    await audit({
      actor, action: "device.configuration.cancel", entityType: "device", entityId: device.id,
      metadata: { mac: device.mac, mode: input.mode },
    });
    return { cancelled: true, message: "Alteração cancelada; nenhuma configuração foi aplicada." };
  }
  if (input.mode === "partner") return configurePartnerList(device, input, actor);
  if (input.mode !== "playlist") throw new AppError(422, "INVALID_MODE", "Modo de configuração inválido.");
  return configurePlaylistList(device, input, actor);
}

async function configurePartnerList(device, input, actor) {
  // Valida código + usuário/senha no provedor (rede) e identifica o parceiro. Sem travas.
  const prepared = await preparePartnerActivation(input);
  const existing = await Activation.findOne({
    where: { deviceId: device.id, partnerId: prepared.partner.id, status: live },
  });

  if (!existing) {
    const activated = await activatePrepared({
      prepared, mac: device.mac, installationId: device.lastInstallationId,
      meta: { ip: actor.ip, userAgent: "admin-device-configuration" },
    });
    await audit({
      actor, action: "device.configuration.confirm", entityType: "device", entityId: device.id,
      metadata: { mac: device.mac, activationId: activated.activation.id, mode: "partner", partnerId: activated.activation.partnerId, added: true },
    });
    return { ...(await stateOf(device)), activationId: activated.activation.id, confirmedAt: new Date().toISOString(), administratorId: actor.id };
  }

  const updated = await sequelize.transaction(async (transaction) => {
    const lockedActivation = await Activation.findOne({
      where: { id: existing.id, status: live },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lockedActivation) {
      throw new AppError(409, "ACTIVATION_REQUIRED", "A ativação mudou; consulte o dispositivo novamente.");
    }
    const partner = await Partner.findByPk(prepared.partner.id, { transaction, lock: transaction.LOCK.UPDATE });
    const code = await PartnerCode.findByPk(prepared.pc.id, { transaction, lock: transaction.LOCK.UPDATE });
    const provider = await PartnerProvider.findByPk(prepared.provider.id, { transaction });
    if (!partner || !code || !provider || code.partnerId !== partner.id || provider.partnerId !== partner.id ||
        code.status !== "active" || (code.expiresAt && code.expiresAt <= new Date()) || provider.status !== "active" ||
        (code.providerId && code.providerId !== provider.id)) {
      throw new AppError(401, "INVALID_CODE_OR_CREDENTIALS", "Código, usuário ou senha inválidos.");
    }
    const overdueSince = await overdueSinceFor(partner.id, transaction);
    const decision = evaluateAccess({ activation: { status: "active" }, partner, overdueSince });
    if (!decision.allowed) throw denialError(decision);
    const used = await Activation.count({
      where: { partnerId: partner.id, status: live, id: { [Op.ne]: lockedActivation.id } },
      transaction,
    });
    if (partner.deviceLimit !== null && used >= partner.deviceLimit) {
      throw new AppError(409, "DEVICE_LIMIT_REACHED", "Limite de dispositivos atingido.");
    }
    if (code.maxActivations !== null) {
      const usedByCode = await Activation.count({
        where: { partnerCodeId: code.id, status: live, id: { [Op.ne]: lockedActivation.id } },
        transaction,
      });
      if (usedByCode >= code.maxActivations) throw new AppError(409, "CODE_LIMIT_REACHED", "Limite de ativações deste código atingido.");
    }
    await lockedActivation.update({
      licenseId: null,
      partnerCodeId: code.id,
      providerId: provider.id,
      credentialsEnc: prepared.credentialsEnc,
      playlistName: null,
      playlistUrlEnc: null,
    }, { transaction });
    await audit({
      actor, action: "device.configuration.confirm", entityType: "device", entityId: device.id,
      metadata: { mac: device.mac, activationId: lockedActivation.id, mode: "partner", partnerId: partner.id, providerId: provider.id, added: false },
      transaction,
    });
    return lockedActivation;
  });
  dropMirrorAuth(updated.id);
  return { ...(await stateOf(device)), activationId: updated.id, confirmedAt: new Date().toISOString(), administratorId: actor.id };
}

async function configurePlaylistList(device, input, actor) {
  const publicUrl = await assertPublicUrl(input.url);
  // A lista própria vive na ativação por licença do MAC (sem parceiro). As ativações por parceria não contam aqui.
  const standalone = await Activation.findOne({ where: { deviceId: device.id, partnerId: null, status: live } });

  if (!standalone) {
    if (!input.licenseCode) {
      throw new AppError(422, "LICENSE_REQUIRED", "Informe o código da licença Delta para ativar este dispositivo.");
    }
    const activated = await activateLicense({
      code: input.licenseCode, mac: device.mac, installationId: device.lastInstallationId,
      meta: { ip: actor.ip, userAgent: "admin-device-configuration" },
    });
    await savePersonalPlaylist(activated.activation.id, { name: input.name, url: publicUrl.href }, actor);
    await audit({
      actor, action: "device.configuration.confirm", entityType: "device", entityId: device.id,
      metadata: { mac: device.mac, activationId: activated.activation.id, mode: "playlist", listName: input.name },
    });
    return { activationId: activated.activation.id, mode: "playlist", listName: input.name, confirmedAt: new Date().toISOString(), administratorId: actor.id };
  }

  if (!standalone.licenseId) {
    throw new AppError(409, "INVALID_STATE", "A ativação deste dispositivo está inconsistente; consulte o dispositivo novamente.");
  }
  const result = await savePersonalPlaylist(standalone.id, { name: input.name, url: publicUrl.href }, actor);
  await audit({
    actor, action: "device.configuration.confirm", entityType: "device", entityId: device.id,
    metadata: { mac: device.mac, activationId: standalone.id, mode: "playlist", listName: input.name },
  });
  return { ...result, confirmedAt: new Date().toISOString(), administratorId: actor.id };
}
