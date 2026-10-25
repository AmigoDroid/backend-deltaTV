import { Op, UniqueConstraintError } from "sequelize";
import {
  sequelize, License, Plan, Partner, PartnerCode, PartnerProvider, Device, Activation,
} from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { normalizeMac } from "../../shared/mac.js";
import { hashCode, encryptSecret } from "../../shared/crypto.js";
import { audit } from "../../shared/audit.js";
import { addMonthsUTC } from "../../shared/dates.js";
import { evaluateAccess } from "../access/access.policy.js";
import { issueSession, overdueSinceFor, denialError, checkActivation, revokeSessionsOf, enforceSessionCap } from "../access/access.service.js";
import { normalizeShortCode, shortCodeProblem } from "../partners/short-code.js";
import { probeCredentials } from "../providers/provider.service.js";
import { sameInstallation } from "../devices/device-identity.js";

const live = { [Op.ne]: "revoked" };
const invalidCode = () => new AppError(404, "INVALID_CODE", "Código inválido.");
// Mesma resposta para código inexistente/revogado/expirado e para usuário/senha recusados:
// não revela quais códigos de parceria existem.
const invalidCredentials = () => new AppError(401, "INVALID_CODE_OR_CREDENTIALS", "Código, usuário ou senha inválidos.");

function installationCheck(activation, installationId) {
  if (activation.installationId && installationId && !sameInstallation(activation.installationId, installationId)) {
    throw new AppError(409, "INSTALLATION_MISMATCH", "Este dispositivo já está ativado em outra instalação.");
  }
}

// Um MAC pode ter várias ativações vivas (uma por parceiro). O installationId é do APARELHO, não da ativação:
// ao criar um novo vínculo, nenhuma ativação viva do mesmo MAC pode pertencer a outra instalação.
async function siblingsInstallationCheck(mac, installationId, transaction) {
  if (!installationId) return;
  const siblings = await Activation.findAll({ where: { mac, status: live }, attributes: ["id", "installationId"], transaction });
  for (const sibling of siblings) installationCheck(sibling, installationId);
}

// Corrida entre escopos (ex.: criação simultânea do mesmo device): reavalia uma vez antes de desistir.
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof UniqueConstraintError)) throw e;
    try {
      return await fn();
    } catch (e2) {
      if (e2 instanceof UniqueConstraintError) throw new AppError(409, "MAC_IN_USE", "Este dispositivo já está ativado com este parceiro ou licença.");
      throw e2;
    }
  }
}

const needMac = (raw) => {
  const mac = normalizeMac(raw);
  if (!mac) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");
  return mac;
};

/* ============ Licença individual (código longo e secreto) ============ */

async function activateLicenseOnce({ code, mac, installationId, idempotencyKey, meta }) {
  return sequelize.transaction(async (t) => {
    const lock = { transaction: t, lock: t.LOCK.UPDATE };
    const idemKey = idempotencyKey ? `${mac}:${idempotencyKey}`.slice(0, 140) : null;

    const license = await License.findOne({ where: { codeHash: hashCode(code) }, ...lock });
    if (!license) throw invalidCode();
    const plan = await Plan.findByPk(license.planId, { transaction: t });

    // Licença "pending" começa a valer na primeira ativação.
    if (license.status === "pending") {
      const start = new Date();
      await license.update({ status: "active", startsAt: start, expiresAt: addMonthsUTC(start, plan.durationMonths) }, { transaction: t });
    }

    // Ativações por parceria no mesmo MAC não ocupam este espaço: só a ativação "sem parceiro" (licença individual) conta.
    let activation = await Activation.findOne({ where: { mac, partnerId: null, status: live }, transaction: t });
    let reused = false;
    if (activation) {
      if (activation.licenseId !== license.id) throw new AppError(409, "MAC_IN_USE", "Este dispositivo já está ativado em outra licença.");
      installationCheck(activation, installationId);
      reused = true;
    } else if (idemKey) {
      const prev = await Activation.findOne({ where: { idempotencyKey: idemKey }, transaction: t });
      if (prev && prev.status !== "revoked" && prev.licenseId === license.id) activation = prev;
    }

    await license.reload({ transaction: t });
    const decision = evaluateAccess({ activation: activation ?? { status: "active" }, license });
    if (!decision.allowed) throw denialError(decision);

    if (!activation) {
      const used = await Activation.count({ where: { licenseId: license.id, status: live }, transaction: t });
      if (used >= license.maxDevices) throw new AppError(409, "DEVICE_LIMIT_REACHED", "Limite de dispositivos da licença atingido.");
      await siblingsInstallationCheck(mac, installationId, t);
      const [device] = await Device.findOrCreate({ where: { mac }, defaults: { mac }, transaction: t });
      await device.update({ lastInstallationId: installationId ?? null, lastSeenAt: new Date() }, { transaction: t });
      activation = await Activation.create(
        { deviceId: device.id, mac, installationId: installationId ?? null, licenseId: license.id, idempotencyKey: idemKey },
        { transaction: t },
      );
    } else if (!activation.installationId && installationId) {
      await activation.update({ installationId }, { transaction: t });
    }

    const session = await issueSession(activation, meta, t);
    await audit({
      actor: { type: "device", id: activation.id, ip: meta.ip }, action: reused ? "activation.reuse" : "activation.create",
      entityType: "activation", entityId: activation.id, metadata: { kind: "license", mac, licenseId: license.id }, transaction: t,
    });
    return { activation, session, reused, expiresAt: decision.expiresAt };
  });
}

export const activateLicense = (input) => {
  const mac = needMac(input.mac);
  return withRetry(() => activateLicenseOnce({ ...input, mac }));
};

/* ============ Parceria: código curto + usuário/senha do provedor ============ */

async function activatePartnerOnce({ codeId, partnerId, provider, credentialsEnc, mac, installationId, idempotencyKey, meta }) {
  return sequelize.transaction(async (t) => {
    const lock = { transaction: t, lock: t.LOCK.UPDATE };
    const idemKey = idempotencyKey ? `${mac}:${idempotencyKey}`.slice(0, 140) : null;

    // Estado reavaliado SOB TRAVA (a fase 1 foi só uma triagem barata).
    const partner = await Partner.findByPk(partnerId, lock);
    const code = await PartnerCode.findByPk(codeId, lock);
    if (!partner || !code || code.partnerId !== partner.id) throw invalidCredentials();
    if (code.status !== "active" || (code.expiresAt && code.expiresAt <= new Date())) throw invalidCredentials();
    // O código aponta para um servidor: se o admin o trocou depois da triagem, a validação das credenciais ficou velha.
    if (code.providerId && code.providerId !== provider.id) throw invalidCredentials();

    // Um MAC pode ter VÁRIOS parceiros: a ativação procurada é a deste MAC COM ESTE parceiro. As ativações dos
    // outros parceiros no mesmo MAC não são tocadas (antes, ativar outro parceiro substituía a ativação existente).
    let activation = await Activation.findOne({ where: { mac, partnerId: partner.id, status: live }, ...lock });
    let reused = false;
    if (activation) {
      installationCheck(activation, installationId);
      // Mesmo parceiro de novo (ex.: troca de usuário/senha ou de código): atualiza a configuração desta ativação.
      reused = true;
    } else if (idemKey) {
      const prev = await Activation.findOne({ where: { idempotencyKey: idemKey }, transaction: t });
      if (prev && prev.status !== "revoked" && prev.partnerId === partner.id) { activation = prev; reused = true; }
    }

    const overdueSince = await overdueSinceFor(partner.id, t);
    const decision = evaluateAccess({ activation: activation ?? { status: "active" }, partner, overdueSince });
    if (!decision.allowed) throw denialError(decision);

    if (!activation) {
      const used = await Activation.count({ where: { partnerId: partner.id, status: live }, transaction: t });
      if (partner.deviceLimit !== null && used >= partner.deviceLimit) {
        throw new AppError(409, "DEVICE_LIMIT_REACHED", "Limite de dispositivos atingido.");
      }
      if (code.maxActivations !== null) {
        const usedByCode = await Activation.count({ where: { partnerCodeId: code.id, status: live }, transaction: t });
        if (usedByCode >= code.maxActivations) throw new AppError(409, "CODE_LIMIT_REACHED", "Limite de ativações deste código atingido.");
      }
      await siblingsInstallationCheck(mac, installationId, t);
      const [device] = await Device.findOrCreate({ where: { mac }, defaults: { mac }, transaction: t });
      await device.update({ lastInstallationId: installationId ?? null, lastSeenAt: new Date() }, { transaction: t });
      activation = await Activation.create(
        {
          deviceId: device.id, mac, installationId: installationId ?? null, partnerId: partner.id, partnerCodeId: code.id,
          providerId: provider.id, credentialsEnc, idempotencyKey: idemKey,
        },
        { transaction: t },
      );
    } else {
      // Reativação com o mesmo parceiro: mantém a ativação e substitui código/provedor/credenciais.
      await activation.update(
        {
          licenseId: null,
          partnerCodeId: code.id,
          providerId: provider.id,
          credentialsEnc,
          playlistName: null,
          playlistUrlEnc: null,
          ...(activation.installationId || !installationId ? {} : { installationId }),
        },
        { transaction: t },
      );
    }

    const otherLive = await Activation.count({ where: { mac, status: live, id: { [Op.ne]: activation.id } }, transaction: t });
    const session = await issueSession(activation, meta, t);
    await audit({
      actor: { type: "device", id: activation.id, ip: meta.ip }, action: reused ? "activation.reuse" : "activation.create",
      entityType: "activation", entityId: activation.id,
      metadata: { kind: "partner", mac, partnerId: partner.id, providerId: provider.id, otherLiveActivationsOnMac: otherLive }, transaction: t,
    });
    return { activation, session, reused, expiresAt: decision.expiresAt };
  });
}

export async function preparePartnerActivation({ code, username, password }) {
  // ---- Fase 1 (sem travas): triagem + validação das credenciais no provedor (rede lenta) ----
  const shortCode = normalizeShortCode(code);
  const pc = shortCodeProblem(shortCode) ? null : await PartnerCode.findOne({ where: { code: shortCode } });
  if (!pc || pc.status !== "active" || (pc.expiresAt && pc.expiresAt <= new Date())) throw invalidCredentials();

  const partner = await Partner.findByPk(pc.partnerId);
  const pre = evaluateAccess({ activation: { status: "active" }, partner, overdueSince: await overdueSinceFor(partner.id) });
  if (!pre.allowed) throw denialError(pre);

  // Código com servidor definido => SÓ esse servidor (sem fallback para outros do parceiro).
  // Código antigo sem servidor (provider_id NULL) => comportamento anterior: servidores ativos por prioridade.
  const providers = await PartnerProvider.findAll({
    where: { partnerId: partner.id, status: "active", ...(pc.providerId ? { id: pc.providerId } : {}) },
    order: [["priority", "ASC"], ["createdAt", "ASC"]],
  });
  if (providers.length === 0) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Serviço indisponível. Contate seu fornecedor.");

  let chosen = null;
  let refused = false;
  let unverified = null; // painel que bloqueou a checagem do servidor (401/403 sem corpo): senha não provada errada
  for (const p of providers) {
    const r = await probeCredentials(p, { username, password });
    if (r.ok) { chosen = p; break; }
    if (r.reason === "invalid") refused = true;
    else if (r.reason === "unverified") unverified ??= p;
  }
  if (!chosen && unverified) {
    // O servidor não consegue validar (IP bloqueado pelo painel), mas a TV consegue falar com ele: guarda as credenciais
    // e deixa o app validar. Se estiverem erradas, a TV/painel recusa.
    console.warn(`[activation] credenciais NÃO verificadas no provedor ${unverified.id} (painel bloqueou o servidor).`);
    chosen = unverified;
  }
  if (!chosen) {
    if (refused) throw invalidCredentials();
    throw new AppError(502, "PROVIDER_UNREACHABLE", "Não foi possível validar com o servidor do provedor. Tente novamente.");
  }

  return { pc, partner, provider: chosen, credentialsEnc: encryptSecret(JSON.stringify({ username, password })) };
}

/** Fase 2 com credenciais já validadas por preparePartnerActivation (evita validar duas vezes no provedor). */
export function activatePrepared({ prepared, mac: rawMac, installationId, idempotencyKey, meta }) {
  const mac = needMac(rawMac);
  return withRetry(() => activatePartnerOnce({
    codeId: prepared.pc.id, partnerId: prepared.partner.id, provider: prepared.provider,
    credentialsEnc: prepared.credentialsEnc, mac, installationId, idempotencyKey, meta,
  }));
}

export async function activatePartner({ code, username, password, mac: rawMac, installationId, idempotencyKey, meta }) {
  const mac = needMac(rawMac);
  const prepared = await preparePartnerActivation({ code, username, password });
  // ---- Fase 2 (transação curta, com travas) ----
  return activatePrepared({ prepared, mac, installationId, idempotencyKey, meta });
}

/* ============ Outras listas do mesmo dispositivo ============ */

/**
 * Sessão para OUTRA lista (ativação) do MESMO dispositivo, a partir de uma sessão válida dele.
 * Um MAC pode ter vários parceiros e cada ativação tem as suas próprias sessões; assim a TV que acabou de ganhar
 * um novo parceiro (adicionado pelo painel) obtém o acesso a ele sem refazer o pareamento.
 * Só vale entre ativações do mesmo dispositivo e da mesma instalação; 404 igual para lista inexistente, revogada ou alheia.
 */
export async function issueSiblingSession({ currentActivation, targetActivationId, installationId, meta }) {
  return sequelize.transaction(async (t) => {
    const target = await Activation.findByPk(targetActivationId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!target || target.status === "revoked" || target.deviceId !== currentActivation.deviceId) {
      throw new AppError(404, "LIST_NOT_FOUND", "Lista não encontrada.");
    }
    const mismatch = (a, b) => a && b && !sameInstallation(a, b);
    if (mismatch(target.installationId, installationId) || mismatch(target.installationId, currentActivation.installationId)) {
      throw new AppError(403, "INSTALLATION_MISMATCH", "Instalação não reconhecida.");
    }
    const { decision } = await checkActivation(target.id, { transaction: t });
    if (!decision.allowed) throw denialError(decision);
    await enforceSessionCap(target.id, t);
    const session = await issueSession(target, meta, t);
    await audit({
      actor: { type: "device", id: currentActivation.id, ip: meta.ip }, action: "activation.sibling_session",
      entityType: "activation", entityId: target.id, metadata: { fromActivationId: currentActivation.id, deviceId: target.deviceId }, transaction: t,
    });
    return { activation: target, session, expiresAt: decision.expiresAt };
  });
}

/* ============ Migração legada e desativação pelo próprio dispositivo ============ */

export async function claimLegacy({ mac: rawMac, installationId, meta }) {
  const mac = needMac(rawMac);
  return sequelize.transaction(async (t) => {
    const activation = await Activation.findOne({
      where: { mac, status: live, claimPending: true }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!activation) throw new AppError(404, "NOTHING_TO_CLAIM", "Nenhuma ativação pendente para este dispositivo.");
    await activation.update({ installationId, claimPending: false }, { transaction: t });
    const { decision } = await checkActivation(activation.id, { transaction: t });
    if (!decision.allowed) throw denialError(decision);
    const session = await issueSession(activation, meta, t);
    await audit({ actor: { type: "device", id: activation.id, ip: meta.ip }, action: "activation.claim", entityType: "activation", entityId: activation.id, transaction: t });
    return { activation, session, expiresAt: decision.expiresAt };
  });
}

// O próprio dispositivo remove a sua ativação (libera a vaga e apaga as credenciais guardadas).
export async function deactivateSelf(activationId, meta) {
  return sequelize.transaction(async (t) => {
    const activation = await Activation.findByPk(activationId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!activation || activation.status === "revoked") return;
    await activation.update(
      { status: "revoked", revokedAt: new Date(), statusReason: "Removida pelo dispositivo", credentialsEnc: null },
      { transaction: t },
    );
    await revokeSessionsOf(activation.id, t);
    await audit({ actor: { type: "device", id: activation.id, ip: meta.ip }, action: "activation.self_revoke", entityType: "activation", entityId: activation.id, transaction: t });
  });
}
