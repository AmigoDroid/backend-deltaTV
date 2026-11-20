/** Tenant-safe operations on a physical MAC. A MAC is global and may belong to
 * several independent networks: these actions NEVER delete another owner's
 * activation or the physical device's global registration. */
import { Op } from "sequelize";
import { Activation, Device, Partner, PartnerCode } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { normalizeMac } from "../../shared/mac.js";
import { changeActivation } from "./device.service.js";
import { deleteScopedActivation } from "../admin-deletion.service.js";

const ACTIVE_ACTIONS = Object.freeze({
  block: ["active"], unblock: ["blocked"], revoke: ["active", "blocked"],
  restore: ["revoked"], delete: ["active", "blocked", "revoked"],
});

/** The ownership join runs on the database. Unrelated resource IDs are 404. */
export async function ownedDevice(deviceId, ownerAdminId) {
  const row = await Device.findOne({
    where: { id: deviceId }, attributes: ["id", "mac", "platform"],
    include: [{ model: Activation, required: true, attributes: ["id"],
      include: [{ model: Partner, attributes: [], required: true, where: { ownerAdminId } }],
    }],
  });
  if (!row) throw notFound("Dispositivo");
  return row;
}

export async function ownedActivation(activationId, ownerAdminId) {
  const row = await Activation.findOne({
    where: { id: activationId }, attributes: ["id", "deviceId", "mac", "partnerId", "status"],
    include: [{ model: Partner, attributes: [], required: true, where: { ownerAdminId } }],
  });
  if (!row) throw notFound("Ativação");
  return row;
}

export async function scopedCode(code, ownerAdminId) {
  const found = await PartnerCode.findOne({
    where: { code, status: "active" }, attributes: ["id"],
    include: [{ model: Partner, attributes: ["id"], required: true, where: { ownerAdminId } }],
  });
  if (!found) throw notFound("Código da rede");
  return found;
}

export async function deviceDeletionPreviewScoped(deviceId, ownerAdminId) {
  const device = await ownedDevice(deviceId, ownerAdminId);
  const ownLinks = await Activation.count({ where: { deviceId },
    include: [{ model: Partner, required: true, attributes: [], where: { ownerAdminId } }],
  });
  return { id: device.id, mac: device.mac, activations: ownLinks,
    affectsAllPartners: false, keepsGlobalMac: true, keepsOtherNetworks: true };
}

/** Bulk per-MAC changes: acquire ownership before every action and recheck it
 * within changeActivation / deleteScopedActivation's transaction. */
export async function scopedDeviceAction(deviceId, action, { reason = "", confirmMac, bulkQuantity = 1 } = {}, actor, ownerAdminId) {
  if (!Object.hasOwn(ACTIVE_ACTIONS, action)) throw new AppError(400, "INVALID_ACTION", "Ação inválida.");
  const device = await ownedDevice(deviceId, ownerAdminId);
  if (action === "delete" && normalizeMac(confirmMac) !== device.mac)
    throw new AppError(422, "CONFIRMATION_MISMATCH", "Confirme exatamente o MAC do aparelho.");
  if ((action === "delete" || action === "block") && reason.trim().length < 3)
    throw new AppError(422, "REASON_REQUIRED", "Informe um motivo com pelo menos três caracteres.");
  const rows = await Activation.findAll({
    where: { deviceId, status: { [Op.in]: ACTIVE_ACTIONS[action] } },
    attributes: ["id", "partnerId", "status", "mac"],
    include: [{ model: Partner, attributes: [], required: true, where: { ownerAdminId } }],
    order: [["id", "ASC"]], limit: 51,
  });
  if (rows.length > 50) throw new AppError(409, "TOO_MANY_LINKS", "Há mais de 50 vínculos neste MAC. Opere por parceiro ou em lotes menores.");
  if (!rows.length) throw new AppError(409, "INVALID_STATE", "Nenhum vínculo desta rede pode receber essa ação.");
  const results = [];
  for (const row of rows) {
    try {
      if (action === "delete") {
        results.push(await deleteScopedActivation(row.id, { confirmMac: device.mac, reason, bulkQuantity }, actor,
          { partnerId: row.partnerId, ownerAdminId }));
      } else {
        await changeActivation(row.id, action, { reason, actor, scope: { partnerId: row.partnerId, ownerAdminId },
          blockedBy: "partner", bulkQuantity });
        results.push({ id: row.id, ok: true, code: action.toUpperCase() });
      }
    } catch (error) {
      results.push({ id: row.id, ok: false, code: error.status && error.status < 500 ? error.code : "ITEM_FAILED",
        message: error.status && error.status < 500 ? error.message : "Falha ao processar vínculo." });
    }
  }
  return { deviceId, mac: device.mac, total: results.length, succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length, results,
    deleted: action === "delete" && results.length > 0 && results.every(r => r.ok),
    keepsGlobalMac: true };
}

export async function bulkScopedDevices(action, ids, options, actor, ownerAdminId) {
  // Verifique a propriedade de TODOS os IDs em UMA consulta antes da primeira
  // mutação: não pode acontecer sucesso parcial quando há ID de outra rede.
  const uniqueIds = [...new Set(ids)];
  const owned = await Device.findAll({
    where: { id: { [Op.in]: uniqueIds } }, attributes: ["id", "mac"],
    include: [{ model: Activation, required: true, attributes: ["id"],
      include: [{ model: Partner, attributes: [], required: true, where: { ownerAdminId } }] }],
  });
  if (new Set(owned.map(d => String(d.id))).size !== uniqueIds.length) throw notFound("Dispositivo");
  const byId = new Map(owned.map(d => [String(d.id), d]));
  const results = [];
  for (const id of uniqueIds) {
    try {
      const entry = await scopedDeviceAction(id, action, {
        ...options, confirmMac: byId.get(String(id)).mac, bulkQuantity: uniqueIds.length,
      }, actor, ownerAdminId);
      results.push({ id, ...entry, ok: entry.failed === 0 });
    } catch (error) {
      results.push({ id, ok: false, code: error.status && error.status < 500 ? error.code : "ITEM_FAILED",
        message: error.status && error.status < 500 ? error.message : "Falha ao processar dispositivo." });
    }
  }
  return { total: results.length, succeeded: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length, results };
}
