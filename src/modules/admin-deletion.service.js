/** Exclusões excepcionais do superadmin. Tudo que altera vínculos executa numa transação.
 * Parcerias são RETIRADAS do uso operacional (tombstone), preservando os vínculos fiscais e
 * os registros financeiros que têm FK RESTRICT. O resumo deixa isso explícito para a UI.
 */
import { Op, QueryTypes } from "sequelize";
import { sequelize, Partner, AdminUser, AuthSession, Activation, Device, WebAccess,
  PartnerCode, PartnerProvider, ResellerClient, AuditLog } from "../db/models/index.js";
import { AppError, notFound } from "../shared/errors.js";
import { audit } from "../shared/audit.js";
import { clearMirrorAuth } from "./mirror/mirror.cache.js";
import { clearContractAccessCache, revokeSessionsOf } from "./access/access.service.js";
import { clearResolutionCache } from "./provider-monitor/resolve.service.js";
import { forgetDevice } from "./devices/presence.js";
import { disconnectPartner, broadcastChange } from "../realtime/socket.js";
import { matchesPartnerDeletionConfirmation } from "./partner-deletion-confirmation.js";

const checkDeletionAuthority = (actor, scopeOwnerId = undefined) => {
  if (actor?.role === 'superadmin') return;
  if (actor?.role === 'admin' && scopeOwnerId && actor.id === scopeOwnerId) return;
  throw new AppError(403, 'DELETION_SCOPE_DENIED', 'Exclusão não autorizada para esta rede.');
};
// Outras exclusões destrutivas permanecem exclusivamente com a DeltaTV.
const checkSuper = actor => {
  if (actor?.role !== 'superadmin') throw new AppError(403, 'DELTATV_ONLY', 'Operação exclusiva da DeltaTV.');
};
const count = (model, where, transaction) => model.count({ where, transaction });
// O estoque da revenda pode ter gerado uma licença individual (activation.partner_id = NULL).
// Nesse caso a posse da licença, e não o código, identifica a revenda responsável.
const ownedActivation = `(a.partner_id = :id OR EXISTS
  (SELECT 1 FROM licenses l WHERE l.id = a.license_id AND l.owner_partner_id = :id))`;

export async function partnerDeletionPreview(id, actor, scopeOwnerId = undefined) {
  checkDeletionAuthority(actor,scopeOwnerId);
  const partner = await Partner.findByPk(id);
  if(partner && scopeOwnerId!==undefined && partner.ownerAdminId!==scopeOwnerId)throw notFound('Parceiro');
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

export async function deletePartnerAsSuper(id, { confirmation, confirmSlug, deleteClients = false, deleteDevices = false, reason }, actor, scopeOwnerId = undefined) {
  checkDeletionAuthority(actor,scopeOwnerId);
  const result = await sequelize.transaction(async (transaction) => {
    const partner = await Partner.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!partner || (scopeOwnerId!==undefined && partner.ownerAdminId!==scopeOwnerId))throw notFound('Revenda ou parceiro');
    if (!matchesPartnerDeletionConfirmation(confirmation ?? confirmSlug, partner)) throw new AppError(422, "CONFIRMATION_MISMATCH", "Confirme o nome ou identificador da revenda ou parceiro mostrado no formulário.");
    if (partner.status === "deleted") throw new AppError(409, "ALREADY_DELETED", "Esta parceria já foi excluída da operação.");
    if (!reason?.trim() || reason.trim().length < 8) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo da exclusão (mínimo de 8 caracteres).");
    // Fotografa os estados ANTES de revogar/desativar, para permitir restauração fiel.
    // Os IDs são mantidos, mas nenhuma senha nem token é salvo na lixeira.
    await sequelize.query(`INSERT INTO partner_trash_snapshots
      (partner_id, previous_status, previous_status_reason, users, codes, providers, web_accesses)
      SELECT p.id, p.status, p.status_reason,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status)) FROM admin_users WHERE partner_id = p.id), '[]'::jsonb),
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status)) FROM partner_codes WHERE partner_id = p.id), '[]'::jsonb),
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status)) FROM partner_providers WHERE partner_id = p.id), '[]'::jsonb),
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'status', status, 'statusReason', status_reason)) FROM web_accesses WHERE partner_id = p.id), '[]'::jsonb)
      FROM partners p WHERE p.id = :id
      ON CONFLICT (partner_id) DO NOTHING`, { replacements: { id }, transaction });
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
    await partner.update({ status: "deleted", statusReason: `Excluído por administração autorizada: ${reason.trim()}`.slice(0, 500) }, { transaction });
    await audit({ actor, action: scopeOwnerId!==undefined?"partner.delete.network_admin":"partner.delete.admin", entityType: "partner", entityId: id,
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

export async function deleteActivationAsSuper(id, { confirmMac, reason, force = false }, actor) {
  checkSuper(actor);
  const result = await sequelize.transaction(async (transaction) => {
    const a = await Activation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!a) throw notFound("Ativação");
    if (a.mac?.trim() !== confirmMac?.trim()) throw new AppError(422, "CONFIRMATION_MISMATCH", "Digite exatamente o MAC do aparelho.");
    if (!reason?.trim() || reason.trim().length < 3) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo (mínimo 3 caracteres).");
    const licenseIds = [a.licenseId, a.grantedLicenseId].filter(Boolean);
    if (licenseIds.length) {
      const active = await sequelize.query(`SELECT 1 FROM licenses WHERE id IN (:ids) AND status='active'
        AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, { replacements: { ids: licenseIds }, type: QueryTypes.SELECT, transaction });
      if (active.length && !force) throw new AppError(409, "ACTIVE_LICENSE", "Licença vigente. Transfira o MAC ou confirme a exclusão forçada com motivo.");
    }
    const meta = { mac: a.mac, deviceId: a.deviceId, partnerId: a.partnerId, reason: reason?.trim() ?? null };
    await a.destroy({ transaction }); // sessões associadas removidas por FK CASCADE
    await audit({ actor, action: "activation.delete.admin", entityType: "activation", entityId: id, metadata: meta, transaction });
    return { deleted: true, deviceId: a.deviceId, partnerId: a.partnerId };
  });
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache(); broadcastChange({ topic: "devices" });
  if (result.partnerId) await notifyScopedDeviceChange(result.partnerId);
  return result;
}

/** Exclui APENAS o vínculo autorizado, nunca o cadastro global do MAC.
 * Uma transação isolada por ID permite lotes com sucesso parcial.
 */
export async function deleteScopedActivation(id, { confirmMac, reason, force = false, bulkQuantity = 1 } = {}, actor, { partnerId } = {}) {
  if (!reason?.trim() || reason.trim().length < 3)
    throw new AppError(422, "REASON_REQUIRED", "Informe o motivo da exclusão (mínimo 3 caracteres).");
  if (force && actor?.role !== "superadmin")
    throw new AppError(403, "FORCE_DENIED", "Somente a DeltaTV pode forçar a exclusão de licença vigente.");
  const result = await sequelize.transaction(async transaction => {
    const a = await Activation.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!a) {
      const previous = await AuditLog.findOne({ where: { entityId: id, entityType: "activation", action: "activation.delete.scoped" }, transaction });
      if (!previous || (partnerId && String(previous.metadata?.partnerId) !== String(partnerId))) throw notFound("Ativação");
      return { id, ok: true, alreadyRemoved: true, code: "ALREADY_REMOVED", message: "Vínculo já excluído." };
    }
    if (partnerId && String(a.partnerId) !== String(partnerId)) throw notFound("Ativação");
    if (!confirmMac || a.mac?.trim() !== confirmMac.trim())
      throw new AppError(422, "CONFIRMATION_MISMATCH", "Digite exatamente o MAC do dispositivo.");
    const licenseIds = [a.licenseId, a.grantedLicenseId].filter(Boolean);
    if (licenseIds.length) {
      const licenses = await sequelize.query(`SELECT id FROM licenses WHERE id IN (:ids)
        AND status = 'active' AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
        { replacements: { ids: licenseIds }, type: QueryTypes.SELECT, transaction });
      if (licenses.length && !force)
        throw new AppError(409, "ACTIVE_LICENSE", "Existe licença vigente. Transfira o MAC ou desvincule a ativação.");
    }
    const deviceId = a.deviceId;
    const mac = a.mac?.trim();
    await revokeSessionsOf(a.id, transaction);
    try { await a.destroy({ transaction }); }
    catch (error) {
      if (["SequelizeForeignKeyConstraintError"].includes(error?.name) || ["23001", "23503"].includes(error?.parent?.code))
        throw new AppError(409, "RELATED_RECORDS", "Este vínculo tem registros dependentes. Desvincule primeiro ou solicite revisão administrativa.");
      throw error;
    }
    await audit({ actor, action: "activation.delete.scoped", entityType: "activation", entityId: id,
      metadata: { mac, partnerId: a.partnerId, deviceId, reason: reason.trim(), forced: Boolean(force), quantity: bulkQuantity }, transaction });
    return { id, ok: true, deleted: true, code: "DELETED", message: "Vínculo excluído.", deviceId, partnerId: a.partnerId };
  });
  if (result.deleted) {
    clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache();
    await notifyScopedDeviceChange(result.partnerId);
  }
  return result;
}

/** Post-commit socket errors must never turn a successful DB operation into an HTTP 500. */
export async function notifyScopedDeviceChange(partnerId) {
  try {
    const owner = partnerId ? await Partner.findByPk(partnerId, { attributes: ["ownerAdminId"] }) : null;
    broadcastChange({ topic: "devices", partnerId: partnerId ?? null, ownerAdminId: owner?.ownerAdminId });
  } catch (error) { console.warn("[device-change] Notificação pendente:", error.message); }
}

export async function bulkScopedActivation(action, ids, body, actor, scope = {}) {
  const results = [];
  for (const id of ids) {
    try {
      if (action === "delete") {
        // Confirmação do lote é pela palavra EXCLUIR; o MAC é consultado com escopo no servidor.
        const a = await Activation.findByPk(id, { attributes: ["id", "mac", "partnerId"] });
        if (a && scope.partnerId && String(a.partnerId) !== String(scope.partnerId)) throw notFound("Ativação");
        results.push(await deleteScopedActivation(id, { ...body, bulkQuantity: ids.length, confirmMac: a?.mac?.trim() }, actor, scope));
      } else {
        const { changeActivation } = await import("./devices/device.service.js");
        const before = await Activation.findByPk(id, { attributes: ["status", "partnerId"] });
        if (before && scope.partnerId && String(before.partnerId) !== String(scope.partnerId)) throw notFound("Ativação");
        if (!before) throw notFound("Ativação");
        if (before.status === "revoked") {
          results.push({ id, ok: true, code: "ALREADY_REMOVED", message: "Vínculo já desvinculado." });
          continue;
        }
        await changeActivation(id, "revoke", { actor, reason: body.reason, scope, blockedBy: "partner", bulkQuantity: ids.length });
        results.push({ id, ok: true, code: "REVOKED", message: "Vínculo desvinculado." });
      }
    } catch (e) {
      results.push({ id, ok: false, code: e.code || "ITEM_FAILED", message: !e.status || e.status >= 500 ? "Falha ao processar vínculo." : (e.message || "Falha ao processar vínculo.") });
    }
  }
  return { total: ids.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
}

export async function deviceDeletionPreview(id, actor) {
  checkSuper(actor);
  const device = await Device.findByPk(id, { attributes: ["id", "mac", "platform"] });
  if (!device) throw notFound("Dispositivo");
  return { id, mac: device.mac?.trim(), platform: device.platform,
    activations: await count(Activation, { deviceId: id }), webAccesses: await count(WebAccess, { deviceId: id }),
    affectsAllPartners: true };
}

export async function deleteDeviceAsSuper(id, { confirmMac, reason, force = false, bulkQuantity = 1 }, actor) {
  checkSuper(actor);
  const result = await sequelize.transaction(async (transaction) => {
    const device = await Device.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!device) throw notFound("Dispositivo");
    if (device.mac?.trim() !== confirmMac?.trim()) throw new AppError(422, "CONFIRMATION_MISMATCH", "Digite exatamente o MAC do aparelho.");
    if (!reason?.trim() || reason.trim().length < 3) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo (mínimo 3 caracteres).");
    const active = await sequelize.query(`SELECT 1 FROM activations a JOIN licenses l
      ON l.id IN (a.license_id, a.granted_license_id) WHERE a.device_id=:id
      AND l.status='active' AND (l.expires_at IS NULL OR l.expires_at > now()) LIMIT 1`,
      { replacements: { id }, type: QueryTypes.SELECT, transaction });
    if (active.length && !force) throw new AppError(409, "ACTIVE_LICENSE", "Existe licença vigente. Transfira o MAC, desvincule ou force com motivo.");
    const activations = await Activation.findAll({ where: { deviceId: id }, attributes: ["id", "partnerId"], transaction, lock: transaction.LOCK.UPDATE });
    const webAccesses = await WebAccess.findAll({ where: { deviceId: id }, attributes: ["partnerId"], transaction });
    const affectedPartners = [...new Set([...activations.map(a => a.partnerId), ...webAccesses.map(w => w.partnerId)].filter(Boolean))];
    const partnerCount = await sequelize.query('SELECT count(DISTINCT partner_id)::int AS n FROM activations WHERE device_id = :id',
      { replacements: { id }, type: QueryTypes.SELECT, transaction });
    await Activation.destroy({ where: { deviceId: id }, transaction });
    // WebAccess é dependência com CASCADE no banco; a exclusão remove também as sessões/chaves do aparelho.
    await device.destroy({ transaction });
    await audit({ actor, action: "device.delete.admin", entityType: "device", entityId: id,
      metadata: { mac: device.mac, activations: activations.length, partnerCount: partnerCount[0]?.n ?? 0, reason, quantity: bulkQuantity }, transaction });
    return { deleted: true, activations: activations.length, affectedPartners };
  });
  clearMirrorAuth(); clearContractAccessCache(); clearResolutionCache(); forgetDevice(id); broadcastChange({ topic: "devices" });
  for (const partnerId of result.affectedPartners) await notifyScopedDeviceChange(partnerId);
  return result;
}

/** Global MAC batch is Superadmin-only and uses the audited existing deletion service per item. */
export async function bulkDeleteDevicesAsSuper(ids, { reason, force = false }, actor) {
  checkSuper(actor);
  if (!reason?.trim() || reason.trim().length < 3) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo (mínimo 3 caracteres).");
  const results = [];
  for (const id of ids) {
    try {
      const device = await Device.findByPk(id, { attributes: ["id", "mac"] });
      if (!device) {
        const previous = await AuditLog.findOne({ where: { entityId: id, entityType: "device", action: "device.delete.admin" } });
        if (!previous) throw notFound("Dispositivo");
        results.push({ id, ok: true, code: "ALREADY_REMOVED", message: "Dispositivo já excluído." });
        continue;
      }
      const active = await sequelize.query(`SELECT 1 FROM activations a JOIN licenses l
        ON l.id IN (a.license_id, a.granted_license_id) WHERE a.device_id = :id
        AND l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at > now()) LIMIT 1`,
        { replacements: { id }, type: QueryTypes.SELECT });
      if (active.length && !force) throw new AppError(409, "ACTIVE_LICENSE", "Licença vigente. Transfira o MAC, desvincule ou force com motivo.");
      await deleteDeviceAsSuper(id, { confirmMac: device.mac?.trim(), reason, force, bulkQuantity: ids.length }, actor);
      results.push({ id, ok: true, code: "DELETED", message: "Aparelho excluído." });
    } catch (e) {
      results.push({ id, ok: false, code: e.code || "ITEM_FAILED", message: !e.status || e.status >= 500 ? "Falha ao processar dispositivo." : e.message });
    }
  }
  return { total: ids.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
}
