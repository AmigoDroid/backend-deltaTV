import { Op } from "sequelize";
import { sequelize, Device, Activation, License, Partner, AuditLog } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { normalizeMac } from "../../shared/mac.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { revokeSessionsOf } from "../access/access.service.js";
import { evaluateResellerAccess, normalizePolicy } from "./device-edit-policy.js";
import * as registration from "./registration.service.js";
import { selectActivation } from "./device-lists.js";
import { applyStockToDevice } from "../stock/stock.service.js";
import { transferGrantedLicense } from "../stock/license-transfer.service.js";
import { isLiveLicense, lockedByLicense } from "../stock/stock-license.js";
import { presenceOf } from "./presence.js";

/**
 * Painel do revendedor: consulta e edição de dispositivo POR MAC.
 *
 * - Quem é o revendedor vem do token (req.user.partnerId); nada de partnerId do cliente.
 * - O MAC só localiza o dispositivo; não autoriza nada. A autorização é: usuário autenticado + revendedor ativo
 *   + política DEVICE_EDIT_POLICY (padrão: qualquer revendedor ativo).
 * - Toda leitura e escrita é auditada com a PESSOA (actorName) e o REVENDEDOR (actorPartnerName).
 */

const DENIED_AUDIT = "device.edit.denied";
// Lida a cada chamada (permite ajustar sem redeploy de código e testar os dois modos). Padrão: any_reseller.
const policyNow = () => normalizePolicy(process.env.DEVICE_EDIT_POLICY);

export async function loadReseller(partnerId) {
  const partner = partnerId ? await Partner.findByPk(partnerId) : null;
  return partner;
}

/** Verifica se a conta pode atuar como revendedor (sem olhar ainda para um dispositivo específico). */
export function assertReseller(partner) {
  const r = evaluateResellerAccess({
    partner, partnerEffectiveStatus: partner ? effectivePartnerStatus(partner) : "none",
    policy: "any_reseller", device: { ownerPartnerIds: [], hasLiveActivation: false },
  });
  if (!r.allowed) throw new AppError(r.status, r.code, r.message);
}

// Um MAC pode ter várias ativações vivas (uma por parceiro, mais a de licença individual).
async function liveActivationsOf(deviceId, transaction) {
  return Activation.findAll({
    where: { deviceId, status: { [Op.ne]: "revoked" } },
    include: [License], order: [["activatedAt", "DESC"], ["id", "ASC"]], transaction,
  });
}

/**
 * Ativação viva que uma operação deve afetar. Com várias listas no MAC, `activationId` é obrigatório
 * (o servidor nunca escolhe por conta própria qual lista remover). Devolve null se não há ativação viva.
 */
export async function selectLiveActivation(deviceId, activationId) {
  const { activation, error } = selectActivation(await liveActivationsOf(deviceId), activationId);
  if (error === "NOT_FOUND") throw notFound("Ativação");
  if (error === "ACTIVATION_REQUIRED") {
    throw new AppError(409, "ACTIVATION_REQUIRED", "Este dispositivo tem mais de uma lista. Informe qual (activationId).");
  }
  return activation;
}

/** Localiza o dispositivo pelo MAC e aplica a política. Falhas de política ficam auditadas. */
async function resolveEditableDevice({ partner, actor, macInput }) {
  const mac = normalizeMac(macInput);
  if (!mac) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");
  const device = await Device.findOne({ where: { mac } });
  if (!device) {
    throw new AppError(404, "DEVICE_NOT_FOUND", "MAC não encontrado. Abra o aplicativo na TV, confira o MAC exibido e tente novamente.");
  }
  const activations = await liveActivationsOf(device.id);
  const policy = policyNow();
  const owners = activations.flatMap((a) => [a.partnerId, a.License?.ownerPartnerId]);
  if (policy === "owner_only" && activations.length) {
    // Em owner_only, também é "dono" o último revendedor que configurou esta TV (a ativação por parceria aponta para o parceiro de conteúdo).
    const last = await AuditLog.findOne({ where: { entityId: String(device.id), action: "device.configuration.confirm", result: "success" }, order: [["createdAt", "DESC"]] });
    owners.push(last?.metadata?.actorPartnerId);
  }
  const decision = evaluateResellerAccess({
    partner, partnerEffectiveStatus: effectivePartnerStatus(partner), policy,
    device: { hasLiveActivation: activations.length > 0, ownerPartnerIds: owners.filter(Boolean) },
  });
  if (!decision.allowed) {
    await audit({ actor, action: DENIED_AUDIT, entityType: "device", entityId: device.id, result: "denied", metadata: { mac, reason: decision.code } });
    throw new AppError(decision.status, decision.code, decision.message);
  }
  return { device, activations, mac };
}

async function lastChangeOf(device, activationIds = []) {
  const ids = [String(device.id), ...activationIds.map(String)];
  const row = await AuditLog.findOne({
    where: { entityId: { [Op.in]: ids }, action: { [Op.in]: ["device.configuration.confirm", "device.list.remove", "activation.revoke", "activation.block", "activation.unblock", "license.transfer.in", "license.transfer.out"] }, result: "success" },
    order: [["createdAt", "DESC"]],
  });
  return row ? publicEvent(row) : null;
}

const publicEvent = (row) => ({
  at: row.createdAt, action: row.action, result: row.result,
  actorType: row.actorType,
  actorName: row.metadata?.actorName ?? null,
  actorPartnerName: row.metadata?.actorPartnerName ?? null,
  details: {
    mode: row.metadata?.mode ?? null, listName: row.metadata?.listName ?? null,
    from: row.metadata?.from ?? null, to: row.metadata?.to ?? null, reason: row.metadata?.reason ?? null,
  },
});

export async function lookupByMac({ partner, actor, mac: macInput }) {
  const { device, activations } = await resolveEditableDevice({ partner, actor, macInput });
  await audit({ actor, action: "device.lookup", entityType: "device", entityId: device.id, metadata: { mac: device.mac } });
  const state = await registration.registeredDeviceById(device.id);
  return {
    ...state,
    platform: device.platform, appVersion: device.appVersion, installationChangedAt: device.installationChangedAt, firstRegisteredAt: device.firstRegisteredAt, ...presenceOf(device.id, device.lastSeenAt),
    lastChange: await lastChangeOf(device, activations.map((a) => a.id)),
  };
}

/** Configura ou substitui a lista. Reaproveita configureDeviceByAdmin (mesma validação do painel admin). */
export async function configureByMac({ partner, actor, mac: macInput, input }) {
  const { device } = await resolveEditableDevice({ partner, actor, macInput });
  return registration.configureDeviceByAdmin(device.id, input, actor);
}

/**
 * Aplica uma licença do ESTOQUE do revendedor ao MAC: ativa uma licença nova ou renova a que o MAC já tem.
 * Mesma autorização e auditoria das demais ações por MAC (política DEVICE_EDIT_POLICY).
 */
export async function applyStockByMac({ partner, actor, mac: macInput, months }) {
  const { device } = await resolveEditableDevice({ partner, actor, macInput });
  return applyStockToDevice({ partner, actor, device, months });
}

/**
 * Passa a licença vendida (concedida pelo código do revendedor) para OUTRO MAC, mantendo o vencimento. A ativação de origem é
 * identificada por `activationId` (nunca por MAC solto) e precisa ser deste revendedor; o destino segue a política de edição por MAC.
 */
export async function transferLicenseToMac({ partner, actor, activationId, toMac }) {
  const { device } = await resolveEditableDevice({ partner, actor, macInput: toMac });
  return transferGrantedLicense({ partner, actor, activationId, toDevice: device });
}

/**
 * Remove UMA lista do dispositivo SEM tocar em fonte/parceria compartilhada, na licença nem nas listas dos outros parceiros:
 *  - lista própria (playlist): apaga só o vínculo da lista no dispositivo; a licença continua ativa;
 *  - parceria (credenciais do provedor): revoga a ativação desta TV com aquele parceiro; parceria e provedor seguem intactos.
 * Com mais de uma lista no MAC, `activationId` indica qual (obrigatório).
 */
export async function removeListByMac({ partner, actor, mac: macInput, reason, activationId }) {
  const { device, mac } = await resolveEditableDevice({ partner, actor, macInput });
  const activation = await selectLiveActivation(device.id, activationId);
  // Licença vendida em vigor: remover jogaria o tempo restante fora. O caminho certo é Transferir para outro MAC.
  if (activation?.grantedLicenseId && isLiveLicense(await License.findByPk(activation.grantedLicenseId))) throw lockedByLicense();
  return removeList({ device, activation, mac, actor, reason });
}

/** Núcleo reutilizado também pelo acesso por chave (sessão limitada ao dispositivo). `activation` = ativação viva ou null. */
export async function removeList({ device, activation, mac, actor, reason }) {
  if (!activation) return { removed: false, code: "NO_ACTIVE_LIST", message: "Este dispositivo não tem lista vinculada." };

  if (activation.licenseId && activation.playlistUrlEnc) {
    await sequelize.transaction(async (transaction) => {
      const locked = await Activation.findByPk(activation.id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!locked || locked.status === "revoked") throw new AppError(409, "INVALID_STATE", "A ativação mudou; consulte o dispositivo novamente.");
      await locked.update({ playlistName: null, playlistUrlEnc: null }, { transaction });
      await audit({
        actor, action: "device.list.remove", entityType: "device", entityId: device.id,
        metadata: { mac, activationId: locked.id, mode: "playlist", listName: activation.playlistName, reason }, transaction,
      });
    });
    return { removed: true, mode: "playlist" };
  }
  if (activation.licenseId) {
    return { removed: false, code: "NO_PERSONAL_LIST", message: "A licença está ativa, mas não há lista própria para remover." };
  }
  await sequelize.transaction(async (transaction) => {
    const locked = await Activation.findByPk(activation.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!locked || locked.status === "revoked") throw new AppError(409, "INVALID_STATE", "A ativação mudou; consulte o dispositivo novamente.");
    await locked.update({ status: "revoked", revokedAt: new Date(), statusReason: reason ?? "Lista removida pelo revendedor", credentialsEnc: null }, { transaction });
    await revokeSessionsOf(locked.id, transaction);
    await audit({
      actor, action: "device.list.remove", entityType: "device", entityId: device.id,
      metadata: { mac, activationId: locked.id, mode: "partner", partnerId: locked.partnerId, reason }, transaction,
    });
  });
  return { removed: true, mode: "partner" };
}

/** Histórico do MAC: quem alterou o quê e quando (somente dados não sensíveis). */
export async function historyByMac({ partner, actor, mac: macInput }) {
  const { device } = await resolveEditableDevice({ partner, actor, macInput });
  const activations = await Activation.findAll({ where: { deviceId: device.id }, attributes: ["id"] });
  const ids = [String(device.id), ...activations.map((a) => String(a.id))];
  const rows = await AuditLog.findAll({
    where: { entityId: { [Op.in]: ids }, action: { [Op.notIn]: ["device.lookup"] } },
    order: [["createdAt", "DESC"]], limit: 100,
  });
  return { mac: device.mac, events: rows.map(publicEvent) };
}
