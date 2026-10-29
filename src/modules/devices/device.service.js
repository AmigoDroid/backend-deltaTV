import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Activation, Device, License, Partner, PartnerProvider, Customer, AuditLog } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { macSearchSql, normalizeMac } from "../../shared/mac.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { revokeSessionsOf, checkActivation } from "../access/access.service.js";
import { dropMirrorAuth } from "../mirror/mirror.cache.js";
import { describeDelivery } from "../mirror/mode.js";
import { evaluateAccess } from "../access/access.policy.js";
import { isLiveLicense, lockedByLicense } from "../stock/stock-license.js";
import { encryptSecret } from "../../shared/crypto.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { parseListUrl, canonicalListUrl } from "./playlist-by-url.service.js";
import { selectLiveActivation, removeList } from "./reseller-devices.service.js";
import { presenceOf, onlineSql } from "./presence.js";

const include = [
  { model: License, attributes: ["id", "status", "statusReason", "startsAt", "expiresAt", "codeLast4"], include: [{ model: Customer, attributes: ["name", "email"] }] },
  { model: License, as: "GrantedLicense", attributes: ["id", "status", "statusReason", "startsAt", "expiresAt", "codeLast4"], required: false },
  { model: Partner, attributes: ["id", "name", "slug", "status", "statusReason", "startsAt", "endsAt", "suspendPolicy", "graceDays"] },
  { model: PartnerProvider, attributes: ["id", "name", "deliveryMode", "status"] },
  { model: Device, attributes: ["id", "platform", "lastSeenAt"], required: false }, // tipo do aparelho (roku, android, tizen, webos, web) + presença
];

/** `scope.partnerId` restringe tudo ao parceiro (isolamento): nunca vem do cliente, vem do token. */
export async function listActivations({ q, status, licenseId, partnerId, online, page, pageSize }, scope = {}) {
  const where = {};
  if (status) where.status = status;
  if (licenseId) where.licenseId = licenseId;
  const effectivePartner = scope.partnerId ?? partnerId;
  if (effectivePartner) where.partnerId = effectivePartner;
  // Busca parcial por MAC, com ou sem ":" ("aabb" acha AA:BB:...). Texto sem nenhum caractere hexadecimal não acha nada.
  const and = [];
  if (q) and.push(sequelize.literal(macSearchSql("Activation", q, (v) => sequelize.escape(v))));
  // Filtro de presença (lê devices.last_seen_at; defasagem máxima = PRESENCE_FLUSH_SECONDS).
  if (online === "true" || online === "false") and.push(sequelize.literal(onlineSql("Device", online === "true")));
  if (and.length) where[Op.and] = and;
  const { rows, count } = await Activation.findAndCountAll({
    where, include, order: [["activatedAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true,
  });
  // O modo efetivo (proxy/redirect) é informação de operação: só o painel admin recebe (o portal do parceiro vem com scope).
  return paged(rows.map((a) => serialize(a, { delivery: !scope.partnerId })), count, { page, pageSize });
}

// Acesso REAL (licença/parceria), sem consultar o banco de novo. Só não enxerga inadimplência (precisa de fatura): getActivation refaz com ela.
const accessOf = (a) => {
  const d = evaluateAccess({ activation: a, license: a.License, grantedLicense: a.GrantedLicense, partner: a.Partner });
  return { allowed: d.allowed, code: d.code, message: d.message };
};

const serialize = (a, { delivery = false } = {}) => ({
  access: accessOf(a),
  id: a.id, deviceId: a.deviceId, mac: a.mac, platform: a.Device?.platform ?? null, ...presenceOf(a.deviceId, a.Device?.lastSeenAt), status: a.status, statusReason: a.statusReason, blockedBy: a.blockedBy,
  activatedAt: a.activatedAt, revokedAt: a.revokedAt, claimPending: a.claimPending,
  licenseId: a.licenseId, partnerId: a.partnerId,
  license: a.License ? { id: a.License.id, status: a.License.status, expiresAt: a.License.expiresAt, codeLast4: a.License.codeLast4, customer: a.License.Customer ? { name: a.License.Customer.name, email: a.License.Customer.email } : null } : null,
  // Licença vendida pelo código do revendedor (estoque): o vencimento é dela. remainingDays = dias inteiros que ainda restam.
  grantedLicense: a.GrantedLicense ? {
    id: a.GrantedLicense.id, codeLast4: a.GrantedLicense.codeLast4, status: a.GrantedLicense.status, statusReason: a.GrantedLicense.statusReason, startsAt: a.GrantedLicense.startsAt, expiresAt: a.GrantedLicense.expiresAt,
    remainingDays: a.GrantedLicense.expiresAt ? Math.max(0, Math.ceil((new Date(a.GrantedLicense.expiresAt).getTime() - Date.now()) / 86_400_000)) : 0,
  } : null,
  partner: a.Partner ? { id: a.Partner.id, name: a.Partner.name, slug: a.Partner.slug, status: a.Partner.status } : null,
  ...(delivery ? { ...describeDelivery(a), listName: a.playlistName ?? null, hasOwnList: !!a.playlistUrlEnc, provider: a.PartnerProvider ? { id: a.PartnerProvider.id, name: a.PartnerProvider.name } : null } : {}),
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
  return { device: { id: device.id, mac: device.mac, ...presenceOf(device.id, device.lastSeenAt) }, activations: activations.map((a) => serialize(a, { delivery: true })), events };
}

const ACTIONS = {
  block: { from: ["active"], to: "blocked" },
  unblock: { from: ["blocked"], to: "active" },
  revoke: { from: ["active", "blocked"], to: "revoked" },
  restore: { from: ["revoked"], to: "active" }, // só superadmin (rota exige a permissão "override")
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
    // Remover apaga as credenciais do provedor: sem elas (e sem lista/licença própria) restaurar devolveria uma ativação que não toca nada.
    if (action === "restore" && !a.licenseId && !a.credentialsEnc) {
      throw new AppError(409, "RESTORE_NOT_POSSIBLE", "As credenciais desta lista foram apagadas quando ela foi removida. Configure a lista de novo (Adicionar parceiro).");
    }
    // O revendedor não joga fora tempo pago: com licença em vigor, a saída é Transferir para outro MAC (o admin da plataforma pode remover).
    if (action === "revoke" && scope.partnerId && a.grantedLicenseId) {
      const granted = await License.findByPk(a.grantedLicenseId, { transaction: t });
      if (isLiveLicense(granted)) throw lockedByLicense();
    }
    if (action === "unblock" && scope.partnerId && a.blockedBy !== "partner") {
      throw new AppError(403, "BLOCKED_BY_PLATFORM", "Este bloqueio foi aplicado pela plataforma.");
    }
    const patch = { status: rule.to };
    if (action === "block") Object.assign(patch, { statusReason: reason, blockedBy });
    if (action === "unblock") Object.assign(patch, { statusReason: null, blockedBy: null });
    if (action === "revoke") Object.assign(patch, { revokedAt: new Date(), statusReason: reason ?? "Removida pelo administrador", credentialsEnc: null });
    if (action === "restore") Object.assign(patch, { revokedAt: null, statusReason: null, blockedBy: null });
    const before = a.status;
    try {
      await a.update(patch, { transaction: t });
    } catch (e) {
      // Índices únicos de ativação viva (MAC+parceiro, MAC avulso, licença concedida): outra ativação já ocupa o lugar.
      if (e instanceof UniqueConstraintError && action === "restore") throw new AppError(409, "MAC_IN_USE", "Este MAC já tem outra ativação viva no mesmo vínculo. Remova a outra antes de restaurar esta.");
      throw e;
    }
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

/**
 * Edição de uma ativação pelo SUPERADMIN (só o painel admin; nunca o portal do parceiro).
 *  - deliveryMode: "proxy" | "redirect" força o modo; null volta ao automático;
 *  - playlistName / playlistUrl: troca a lista própria (link M3U completo: o servidor extrai servidor, usuário e senha);
 *  - removeList: remove a lista própria (a ativação de parceria volta a usar o provedor da parceria).
 */
export async function editActivation(id, input, actor) {
  const patch = {};
  const changes = {};
  if (input.deliveryMode !== undefined) {
    patch.deliveryMode = input.deliveryMode;
    changes.deliveryMode = input.deliveryMode;
  }
  if (input.removeList) {
    Object.assign(patch, { playlistName: null, playlistUrlEnc: null });
    changes.listRemoved = true;
  } else {
    if (input.playlistUrl) {
      const cred = parseListUrl(input.playlistUrl);
      await assertPublicUrl(cred.baseUrl);
      patch.playlistUrlEnc = encryptSecret(canonicalListUrl(cred));
      changes.listUrlHost = new URL(cred.baseUrl).hostname;
    }
    if (input.playlistName !== undefined) {
      patch.playlistName = input.playlistName;
      changes.listName = input.playlistName;
    }
  }
  if (Object.keys(patch).length === 0) throw new AppError(422, "NOTHING_TO_CHANGE", "Nenhuma alteração informada.");

  const row = await sequelize.transaction(async (t) => {
    const a = await Activation.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw notFound("Ativação");
    if (a.status === "revoked") throw new AppError(409, "INVALID_STATE", "Esta ativação foi removida e não pode ser editada.");
    if (patch.playlistName !== undefined && patch.playlistName !== null && !a.playlistUrlEnc && !patch.playlistUrlEnc) {
      throw new AppError(422, "NO_OWN_LIST", "Este dispositivo não tem lista própria: informe também o link da lista.");
    }
    await a.update(patch, { transaction: t });
    await audit({
      actor, action: "device.admin.edit", entityType: "activation", entityId: a.id,
      metadata: { mac: a.mac, ...changes }, transaction: t,
    });
    return a;
  });
  dropMirrorAuth(row.id); // vale já para o espelho (depois do commit)
  return getActivation(row.id);
}

/**
 * Remove UMA lista de um dispositivo pelo painel (sem chave da TV). Mesma regra do acesso por chave:
 * com mais de uma lista no MAC, `activationId` é obrigatório. Não há trava de licença vendida: quem chega aqui é a equipe do painel.
 */
export async function removeListByAdmin(deviceId, { activationId, reason }, actor) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  const activation = await selectLiveActivation(device.id, activationId);
  return removeList({ device, activation, mac: device.mac, actor, reason });
}
