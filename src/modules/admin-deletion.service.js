/** Exclusões excepcionais do superadmin. Tudo que altera vínculos executa numa transação.
 * Parcerias são RETIRADAS do uso operacional (tombstone), preservando os vínculos fiscais e
 * os registros financeiros que têm FK RESTRICT. O resumo deixa isso explícito para a UI.
 */
import { Op, QueryTypes } from "sequelize";
import { sequelize, Partner, AdminUser, AuthSession, Activation, Device, WebAccess,
  PartnerCode, PartnerProvider, ResellerClient } from "../db/models/index.js";
import { AppError, notFound } from "../shared/errors.js";
import { audit } from "../shared/audit.js";
import { clearMirrorAuth } from "./mirror/mirror.cache.js";
import { clearContractAccessCache } from "./access/access.service.js";
import { clearResolutionCache } from "./provider-monitor/resolve.service.js";
import { forgetDevice } from "./devices/presence.js";
import { disconnectPartner, broadcastChange } from "../realtime/socket.js";

const checkSuper = (actor) => {
  if (actor?.role !== "superadmin") throw new AppError(403, "SUPERADMIN_ONLY", "Somente o superadmin pode executar essa exclusão.");
};
const count = (model, where, transaction) => model.count({ where, transaction });
// O estoque da revenda pode ter gerado uma licença individual (activation.partner_id = NULL).
// Nesse caso a posse da licença, e não o código, identifica a revenda responsável.
const ownedActivation = `(a.partner_id = :id OR EXISTS
  (SELECT 1 FROM licenses l WHERE l.id = a.license_id AND l.owner_partner_id = :id))`;

export async function partnerDeletionPreview(id, actor) {
  checkSuper(actor);
  const partner = await Partner.findByPk(id);
  if (!partner) throw notFound("Revenda ou parceiro");
  const [clients, activationTotals, codes, users, providers, exclusiveDevices] = await Promise.all([
    count(ResellerClient, { partnerId: id }),
    sequelize.query(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE a.status <> 'revoked')::int AS live,
      count(*) FILTER (WHERE a.partner_id IS NULL)::int AS independent
      FROM activations a WHERE ${ownedActivation}`,
      { replacements: { id }, type: QueryTypes.SELECT }).then((r) => r[0]),
    count(PartnerCode, { partnerId: id }), count(AdminUser, { partnerId: id }),
    count(PartnerProvider, { partnerId: id }),
    // Aparelhos compartilhados nunca devem ser apagados junto com apenas uma parceria.
    sequelize.query(`SELECT count(*)::int AS n FROM devices d WHERE EXISTS
      (SELECT 1 FROM activations a WHERE a.device_id = d.id AND ${ownedActivation})
      AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = d.id AND (${ownedActivation}) IS NOT TRUE)
      AND NOT EXISTS (SELECT 1 FROM web_accesses w WHERE w.device_id = d.id AND (w.partner_id IS DISTINCT FROM :id))`,
      { replacements: { id }, type: QueryTypes.SELECT }).then((r) => Number(r[0]?.n ?? 0)),
  ]);
  return { id, name: partner.name, slug: partner.slug, kind: partner.kind, alreadyDeleted: partner.status === "deleted",
    clients, activations: Number(activationTotals.total), liveActivations: Number(activationTotals.live),
    independentLicenseActivations: Number(activationTotals.independent), codes, users, providers, exclusiveDevices,
    retainedFinancialHistory: true, deleteIsArchive: true };
}

export async function deletePartnerAsSuper(id, { confirmSlug, deleteClients = false, deleteDevices = false, reason }, actor) {
  checkSuper(actor);
  const result = await sequelize.transaction(async (transaction) => {
    const partner = await Partner.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!partner) throw notFound("Revenda ou parceiro");
    if (partner.slug !== confirmSlug) throw new AppError(422, "CONFIRMATION_MISMATCH", "Confirme o identificador exato da revenda ou parceiro.");
    if (partner.status === "deleted") throw new AppError(409, "ALREADY_DELETED", "Esta parceria já foi excluída da operação.");
    if (!reason?.trim() || reason.trim().length < 8) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo da exclusão (mínimo de 8 caracteres).");
    // Todas as sessões de usuários são revogadas dentro da transação, inclusive refresh tokens.
    const users = await AdminUser.findAll({ where: { partnerId: id }, attributes: ["id"], transaction });
    const userIds = users.map((u) => u.id);
    if (userIds.length) {
      await AuthSession.update({ revokedAt: new Date() }, { where: { adminUserId: { [Op.in]: userIds }, revokedAt: null }, transaction });
      await AdminUser.update({ status: "disabled", tokenVersion: sequelize.literal('token_version + 1') }, { where: { partnerId: id }, transaction });
    }
    await PartnerCode.update({ status: "revoked" }, { where: { partnerId: id }, transaction });
    await WebAccess.update({ status: "revoked", statusReason: "Revenda excluída administrativamente" }, { where: { partnerId: id }, transaction });
    await PartnerProvider.update({ status: "disabled" }, { where: { partnerId: id }, transaction });
    let removedClients = 0, removedActivations = 0, removedDevices = 0;
    const removedDeviceIds = [];
    if (deleteClients) removedClients = await ResellerClient.destroy({ where: { partnerId: id }, transaction });
    if (deleteDevices) {
      // Aparelhos de outro parceiro são preservados. Lotes fixos para não carregar
      // milhares de ativações em memória de uma vez (VPS de 2 GB).
      const web = await WebAccess.findAll({ where: { partnerId: id }, attributes: ["deviceId"], transaction });
      await WebAccess.destroy({ where: { partnerId: id }, transaction });
      const webDeviceIds = [...new Set(web.map((w) => w.deviceId))];
      while (true) {
        const batch = await sequelize.query(`SELECT a.id, a.device_id AS "deviceId" FROM activations a
          WHERE ${ownedActivation} ORDER BY a.id LIMIT 500 FOR UPDATE OF a`,
          { replacements: { id }, type: QueryTypes.SELECT, transaction });
        if (!batch.length) break;
        const ids = batch.map((a) => a.id);
        removedActivations += await Activation.destroy({ where: { id: { [Op.in]: ids } }, transaction });
        // Apaga somente os aparelhos órfãos; dispositivos de terceiros são mantidos.
        const [rows] = await sequelize.query(`DELETE FROM devices d WHERE d.id IN (:ids)
          AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM web_accesses w WHERE w.device_id = d.id)
          RETURNING d.id`, { replacements: { ids: [...new Set(batch.map((a) => a.deviceId))] }, transaction });
        removedDevices += rows.length;
        for (const row of rows) if (removedDeviceIds.length < 20000) removedDeviceIds.push(row.id);
        // O commit é único; eventual erro interrompe tudo e faz ROLLBACK.
      }
      // Pode haver WebAccess sem ativação (ex.: código revogado há muito tempo).
      for (let offset = 0; offset < webDeviceIds.length; offset += 500) {
        const [rows] = await sequelize.query(`DELETE FROM devices d WHERE d.id IN (:ids)
          AND NOT EXISTS (SELECT 1 FROM activations a WHERE a.device_id = d.id)
          AND NOT EXISTS (SELECT 1 FROM web_accesses w WHERE w.device_id = d.id)
          RETURNING d.id`, { replacements: { ids: webDeviceIds.slice(offset, offset + 500) }, transaction });
        removedDevices += rows.length;
        for (const row of rows) if (removedDeviceIds.length < 20000) removedDeviceIds.push(row.id);
      }
    }
    await partner.update({ status: "deleted", statusReason: `Excluído pelo superadmin: ${reason.trim()}`.slice(0, 500) }, { transaction });
    await audit({ actor, action: "partner.delete.admin", entityType: "partner", entityId: id,
      metadata: { name: partner.name, slug: partner.slug, kind: partner.kind, deleteClients, deleteDevices,
        removedClients, removedActivations, removedDevices, retainedFinancialHistory: true, reason }, transaction });
    return { deleted: true, mode: "archived_with_financial_history", removedClients, removedActivations, removedDevices, removedDeviceIds };
  });
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache();
  for (const deviceId of result.removedDeviceIds) forgetDevice(deviceId);
  delete result.removedDeviceIds;
  disconnectPartner(id); broadcastChange({ topic: "partners" }); broadcastChange({ topic: "devices" });
  return result;
}

export async function activationDeletionPreview(id, actor) {
  checkSuper(actor);
  const a = await Activation.findByPk(id, { attributes: ["id", "deviceId", "mac", "partnerId", "status"] });
  if (!a) throw notFound("Ativação");
  return { id: a.id, deviceId: a.deviceId, mac: a.mac?.trim(), status: a.status, otherActivations: await count(Activation, { deviceId: a.deviceId, id: { [Op.ne]: id } }) };
}

export async function deleteActivationAsSuper(id, { confirmMac, reason }, actor) {
  checkSuper(actor);
  const result = await sequelize.transaction(async (transaction) => {
    const a = await Activation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!a) throw notFound("Ativação");
    if (a.mac?.trim() !== confirmMac?.trim()) throw new AppError(422, "CONFIRMATION_MISMATCH", "Digite exatamente o MAC do aparelho.");
    const meta = { mac: a.mac, deviceId: a.deviceId, partnerId: a.partnerId, reason: reason?.trim() ?? null };
    await a.destroy({ transaction }); // sessões associadas removidas por FK CASCADE
    await audit({ actor, action: "activation.delete.admin", entityType: "activation", entityId: id, metadata: meta, transaction });
    return { deleted: true, deviceId: a.deviceId };
  });
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache(); broadcastChange({ topic: "devices" });
  return result;
}

export async function deviceDeletionPreview(id, actor) {
  checkSuper(actor);
  const device = await Device.findByPk(id, { attributes: ["id", "mac", "platform"] });
  if (!device) throw notFound("Dispositivo");
  return { id, mac: device.mac?.trim(), platform: device.platform,
    activations: await count(Activation, { deviceId: id }), webAccesses: await count(WebAccess, { deviceId: id }),
    affectsAllPartners: true };
}

export async function deleteDeviceAsSuper(id, { confirmMac, reason }, actor) {
  checkSuper(actor);
  const result = await sequelize.transaction(async (transaction) => {
    const device = await Device.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!device) throw notFound("Dispositivo");
    if (device.mac?.trim() !== confirmMac?.trim()) throw new AppError(422, "CONFIRMATION_MISMATCH", "Digite exatamente o MAC do aparelho.");
    const activations = await Activation.findAll({ where: { deviceId: id }, attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE });
    const partnerCount = await sequelize.query('SELECT count(DISTINCT partner_id)::int AS n FROM activations WHERE device_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction });
    await Activation.destroy({ where: { deviceId: id }, transaction });
    // WebAccess é dependência com CASCADE no banco; a exclusão remove também as sessões/chaves do aparelho.
    await device.destroy({ transaction });
    await audit({ actor, action: "device.delete.admin", entityType: "device", entityId: id,
      metadata: { mac: device.mac, activations: activations.length, partnerCount: partnerCount[0]?.n ?? 0, reason }, transaction });
    return { deleted: true, activations: activations.length };
  });
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache(); forgetDevice(id); broadcastChange({ topic: "devices" });
  return result;
}
