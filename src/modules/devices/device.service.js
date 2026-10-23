import { Op } from "sequelize";
import { sequelize, Activation, Device, License, Partner, PartnerProvider, Customer, AuditLog } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { macSearchSql, normalizeMac } from "../../shared/mac.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { revokeSessionsOf, checkActivation } from "../access/access.service.js";
import { dropMirrorAuth } from "../mirror/mirror.cache.js";
import { describeDelivery } from "../mirror/mode.js";

const include = [
  { model: License, attributes: ["id", "status", "expiresAt", "codeLast4"], include: [{ model: Customer, attributes: ["name", "email"] }] },
  { model: Partner, attributes: ["id", "name", "slug", "status"] },
  { model: PartnerProvider, attributes: ["id", "name", "deliveryMode", "status"] },
];

/** `scope.partnerId` restringe tudo ao parceiro (isolamento): nunca vem do cliente, vem do token. */
export async function listActivations({ q, status, licenseId, partnerId, page, pageSize }, scope = {}) {
  const where = {};
  if (status) where.status = status;
  if (licenseId) where.licenseId = licenseId;
  const effectivePartner = scope.partnerId ?? partnerId;
  if (effectivePartner) where.partnerId = effectivePartner;
  // Busca parcial por MAC, com ou sem ":" ("aabb" acha AA:BB:...). Texto sem nenhum caractere hexadecimal não acha nada.
  if (q) where[Op.and] = [sequelize.literal(macSearchSql("Activation", q, (v) => sequelize.escape(v)))];
  const { rows, count } = await Activation.findAndCountAll({
    where, include, order: [["activatedAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true,
  });
  // O modo efetivo (proxy/redirect) é informação de operação: só o painel admin recebe (o portal do parceiro vem com scope).
  return paged(rows.map((a) => serialize(a, { delivery: !scope.partnerId })), count, { page, pageSize });
}

const serialize = (a, { delivery = false } = {}) => ({
  id: a.id, deviceId: a.deviceId, mac: a.mac, status: a.status, statusReason: a.statusReason, blockedBy: a.blockedBy,
  activatedAt: a.activatedAt, revokedAt: a.revokedAt, claimPending: a.claimPending,
  licenseId: a.licenseId, partnerId: a.partnerId,
  license: a.License ? { id: a.License.id, status: a.License.status, expiresAt: a.License.expiresAt, codeLast4: a.License.codeLast4, customer: a.License.Customer ? { name: a.License.Customer.name, email: a.License.Customer.email } : null } : null,
  partner: a.Partner ? { id: a.Partner.id, name: a.Partner.name, slug: a.Partner.slug, status: a.Partner.status } : null,
  ...(delivery ? { ...describeDelivery(a), provider: a.PartnerProvider ? { id: a.PartnerProvider.id, name: a.PartnerProvider.name } : null } : {}),
});

export async function getActivation(id, scope = {}) {
  const where = { id };
  if (scope.partnerId) where.partnerId = scope.partnerId;
  const a = await Activation.findOne({ where, include });
  if (!a) throw notFound("Ativação"); // 404 também para ativações de outro parceiro (sem vazar existência)
  const { decision } = await checkActivation(a.id);
  return { ...serialize(a, { delivery: !scope.partnerId }), access: { allowed: decision.allowed, code: decision.code } };
}

// Histórico completo do MAC: todas as ativações (inclusive revogadas) + trilha de auditoria.
export async function deviceHistory(mac) {
  const norm = normalizeMac(mac);
  if (!norm) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");
  const device = await Device.findOne({ where: { mac: norm } });
  if (!device) throw notFound("Dispositivo");
  const activations = await Activation.findAll({ where: { deviceId: device.id }, include, order: [["activatedAt", "DESC"]] });
  const ids = activations.map((a) => String(a.id));
  // Eventos das ativações (bloquear/remover...) e do próprio dispositivo (lista configurada/removida). "register" (cada abertura
  // do app) e "lookup" (consultas) ficam de fora: seriam ruído.
  const events = await AuditLog.findAll({
    where: {
      [Op.or]: [
        ...(ids.length ? [{ entityType: "activation", entityId: { [Op.in]: ids } }] : []),
        { entityType: "device", entityId: String(device.id), action: { [Op.notIn]: ["device.register", "device.lookup"] } },
      ],
    },
    order: [["createdAt", "DESC"]], limit: 200,
  });
  return { device: { id: device.id, mac: device.mac, lastSeenAt: device.lastSeenAt }, activations: activations.map((a) => serialize(a, { delivery: true })), events };
}

const ACTIONS = {
  block: { from: ["active"], to: "blocked" },
  unblock: { from: ["blocked"], to: "active" },
  revoke: { from: ["active", "blocked"], to: "revoked" },
};

/**
 * block   -> só aquele dispositivo perde acesso (reversível)
 * unblock -> devolve o acesso (se licença/parceria continuarem elegíveis)
 * revoke  -> remove a ativação, derruba sessões e libera o MAC para nova ativação
 */
export async function changeActivation(id, action, { reason, actor, scope = {}, blockedBy }) {
  const rule = ACTIONS[action];
  if (!rule) throw new AppError(400, "INVALID_ACTION", "Ação inválida.");
  const changed = await sequelize.transaction(async (t) => {
    const where = { id };
    if (scope.partnerId) where.partnerId = scope.partnerId;
    const a = await Activation.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound("Ativação");
    if (!rule.from.includes(a.status)) {
      throw new AppError(409, "INVALID_STATE", `Não é possível executar '${action}' em uma ativação '${a.status}'.`);
    }
    if (action === "block" && !reason) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo do bloqueio.");
    if (action === "unblock" && scope.partnerId && a.blockedBy !== "partner") {
      throw new AppError(403, "BLOCKED_BY_PLATFORM", "Este bloqueio foi aplicado pela plataforma.");
    }
    const patch = { status: rule.to };
    if (action === "block") Object.assign(patch, { statusReason: reason, blockedBy });
    if (action === "unblock") Object.assign(patch, { statusReason: null, blockedBy: null });
    if (action === "revoke") Object.assign(patch, { revokedAt: new Date(), statusReason: reason ?? "Removida pelo administrador", credentialsEnc: null });
    const before = a.status;
    await a.update(patch, { transaction: t });
    if (action === "revoke") await revokeSessionsOf(a.id, t);
    await audit({
      actor, action: `activation.${action}`, entityType: "activation", entityId: a.id,
      metadata: { mac: a.mac, from: before, to: rule.to, reason }, transaction: t,
    });
    return a;
  });
  dropMirrorAuth(changed.id); // bloquear/desbloquear/remover valem já para o espelho (depois do commit)
  return changed;
}
