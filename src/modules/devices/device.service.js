import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Activation, Device, License, Partner, PartnerProvider, Customer, AuditLog, AdminUser, WebAccess } from "../../db/models/index.js";
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
import { presenceOf, flushPresence } from "./presence.js";
import { env } from "../../config/env.js";

const include = [
  { model: License, attributes: ["id", "status", "statusReason", "startsAt", "expiresAt", "codeLast4", "isTrial"], include: [{ model: Customer, attributes: ["name", "email"] }] },
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
  // O filtro precisa usar a mesma presença dos cartões (memória + banco).
  // Antes de consultar, persiste os sinais recentes desta instância. Sem isso, a lista
  // pode mostrar um dispositivo Online enquanto o filtro SQL ainda o considera Offline.
  if (online === "true" || online === "false") {
    await flushPresence();
    // EXISTS correlacionado funciona também quando Sequelize aplica LIMIT em uma
    // subconsulta. Uma condição direta em "Device" falha nesse caso porque o JOIN
    // de Device pode ficar apenas na consulta externa da paginação.
    const live = `EXISTS (SELECT 1 FROM devices AS presence_device
      WHERE presence_device.id = "Activation"."device_id"
        AND presence_device.last_seen_at >= now() - (${Math.trunc(env.presenceWindowSeconds)} * interval '1 second'))`;
    and.push(sequelize.literal(online === "true" ? live : `NOT (${live})`));
  }
  if (and.length) where[Op.and] = and;
  const { rows, count } = await Activation.findAndCountAll({
    where, include, order: [["activatedAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true,
  });
  // O modo efetivo (proxy/redirect) é informação de operação: só o painel admin recebe (o portal do parceiro vem com scope).
  return paged(rows.map((a) => serialize(a, { delivery: !scope.partnerId })), count, { page, pageSize });
}

/** Pagina aparelhos antes de carregar os vínculos: cada MAC ocupa exatamente uma linha. */
export async function listDevices({ q, status, online, page, pageSize }) {
  const conditions = [sequelize.literal('"Device"."mac" IS NOT NULL')];
  if (q) conditions.push(sequelize.literal(macSearchSql("Device", q, value => sequelize.escape(value))));
  const exists = clause => `EXISTS (SELECT 1 FROM activations a WHERE a.device_id = "Device".id ${clause})`;
  if (status === "active") conditions.push(sequelize.literal(exists("AND a.status = 'active'")));
  if (status === "blocked") conditions.push(sequelize.literal(`NOT (${exists("AND a.status = 'active'")}) AND ${exists("AND a.status = 'blocked'")}`));
  if (status === "revoked") conditions.push(sequelize.literal(`${exists("")} AND NOT (${exists("AND a.status <> 'revoked'")})`));
  if (status === "unlinked") conditions.push(sequelize.literal(`NOT (${exists("")})`));
  if (online === "true" || online === "false") {
    await flushPresence();
    const recent = `"Device".last_seen_at >= now() - (${Math.trunc(env.presenceWindowSeconds)} * interval '1 second')`;
    conditions.push(sequelize.literal(online === "true" ? recent : `("Device".last_seen_at IS NULL OR NOT (${recent}))`));
  }
  const total = state => `(SELECT count(*) FROM activations a WHERE a.device_id = "Device".id AND a.status = '${state}')`;
  const { rows, count } = await Device.findAndCountAll({
    where: conditions.length ? { [Op.and]: conditions } : {},
    attributes: { include: [[sequelize.literal(total("active")), "activeCount"], [sequelize.literal(total("blocked")), "blockedCount"], [sequelize.literal(total("revoked")), "removedCount"]] },
    order: [["updatedAt", "DESC"], ["id", "DESC"]], ...pageOf({ page, pageSize }),
  });
  const activations = rows.length ? await Activation.findAll({ where: { deviceId: { [Op.in]: rows.map(d => d.id) }, status: { [Op.ne]: "revoked" } }, include, order: [["activatedAt", "DESC"]] }) : [];
  const grouped = new Map();
  for (const a of activations) { if (!grouped.has(a.deviceId)) grouped.set(a.deviceId, []); grouped.get(a.deviceId).push(a); }
  return paged(rows.map(device => {
    const d = device.toJSON();
    const activeCount = Number(d.activeCount || 0), blockedCount = Number(d.blockedCount || 0), removedCount = Number(d.removedCount || 0);
    const current = grouped.get(d.id) || [];
    return { id: d.id, deviceId: d.id, mac: d.mac, platform: d.platform, ...presenceOf(d.id, d.lastSeenAt),
      createdAt: d.createdAt, updatedAt: d.updatedAt, activeCount, blockedCount, removedCount, currentCount: activeCount + blockedCount,
      status: activeCount ? "active" : blockedCount ? "blocked" : removedCount ? "revoked" : "unlinked",
      partners: [...new Set(current.map(a => a.Partner?.name).filter(Boolean))],
    };
  }), count, { page, pageSize });
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
  license: a.License ? { id: a.License.id, status: a.License.status, expiresAt: a.License.expiresAt, codeLast4: a.License.codeLast4, isTrial: a.License.isTrial, customer: a.License.Customer ? { name: a.License.Customer.name, email: a.License.Customer.email } : null } : null,
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
export async function deviceHistory(mac, { page = 1, pageSize = 20 } = {}) {
  const norm = normalizeMac(mac);
  if (!norm) throw new AppError(400, "INVALID_MAC", "Endereço MAC inválido.");
  const device = await Device.findOne({ where: { mac: norm } });
  if (!device) throw notFound("Dispositivo");
  const activations = await Activation.findAll({ where: { deviceId: device.id }, include, order: [["activatedAt", "DESC"], ["id", "DESC"]] });
  const ids = activations.map(a => String(a.id));
  const webAccesses = await WebAccess.findAll({ where: { deviceId: device.id }, attributes: ["id"] });
  const where = { action: { [Op.notIn]: ["device.register", "device.lookup", "web_access.login"] }, [Op.or]: [
    ...(ids.length ? [{ entityType: "activation", entityId: { [Op.in]: ids } }] : []),
    { entityType: "device", entityId: String(device.id) },
    ...(webAccesses.length ? [{ entityType: "web_access", entityId: { [Op.in]: webAccesses.map(w => String(w.id)) } }] : []),
    // Mantém eventos de ativações excluídas e ciclos anteriores do mesmo MAC.
    sequelize.where(sequelize.literal("metadata ->> 'mac'"), norm),
  ] };
  const { rows: events, count } = await AuditLog.findAndCountAll({ where, order: [["createdAt", "DESC"], ["id", "DESC"]], ...pageOf({ page, pageSize }) });
  const peopleIds = [...new Set(events.filter(e => ["admin", "partner"].includes(e.actorType) && /^[0-9a-f-]{36}$/i.test(e.actorId || "")).map(e => e.actorId))];
  const people = peopleIds.length ? await AdminUser.findAll({ where: { id: { [Op.in]: peopleIds } }, attributes: ["id", "name"] }) : [];
  const byId = new Map(people.map(user => [String(user.id), user.name]));
  return { device: { id: device.id, deviceId: device.id, mac: device.mac, platform: device.platform, ...presenceOf(device.id, device.lastSeenAt) },
    activations: activations.map(a => serialize(a, { delivery: true })),
    events: events.map(event => ({ ...event.toJSON(), actorName: event.metadata?.actorName || byId.get(String(event.actorId)) || ({device:"Próprio dispositivo",anonymous:"Acesso público",system:"Sistema"}[event.actorType] ?? "Não identificado") })),
    eventsMeta: paged([], count, { page, pageSize }).meta,
  };
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
      throw new AppError(409, "INVALID_STATE", "Esta ação não está disponível para o estado atual da ativação. Atualize a lista e tente novamente.");
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
  // A licença já está alterada no banco: o comando apenas solicita que a TV
  // confira o novo estado. Não invalidar a alteração se a fila falhar.
  if (action === 'block' || action === 'unblock') {
    try {
      const { queueRemoteCommand } = await import('../../realtime/remote-control.service.js');
      await queueRemoteCommand({ activationId: changed.id, type: 'sync-access',
        actor, partnerId: scope.partnerId || null });
    } catch (e) { console.warn('[remote-command] estado atualizado sem ACK pendente:', e.message); }
  }
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
    // A escolha global feita pelo admin substitui overrides antigos por tipo.
    patch.deliveryModes = null;
    changes.deliveryModes = null;
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
    // O superadmin pode corrigir a configuração histórica de uma ativação removida.
    // A edição não restaura o acesso: o status revoked permanece inalterado.
    if (a.status === "revoked" && actor?.role !== "superadmin") throw new AppError(409, "INVALID_STATE", "Esta ativação foi removida e não pode ser editada.");
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

/** Proveniência de cada ativação/lista, baseada em auditoria histórica.
 * Não atribui a uma pessoa ações anônimas ou realizadas pelo próprio aparelho.
 */
export async function deviceAttribution(deviceId) {
  const device = await Device.findByPk(deviceId);
  if (!device) throw notFound("Dispositivo");
  const activations = await Activation.findAll({ where: { deviceId }, attributes: ["id", "activatedAt", "playlistName", "partnerId", "licenseId", "status"], order: [["activatedAt", "DESC"]] });
  const ids = activations.map(row => String(row.id));
  const events = await AuditLog.findAll({
    where: { [Op.or]: [
      { entityType: "device", entityId: String(deviceId) },
      ...(ids.length ? [{ entityType: "activation", entityId: { [Op.in]: ids } }] : []),
    ] }, order: [["createdAt", "ASC"], ["id", "ASC"]],
    attributes: ["id", "actorType", "actorId", "action", "entityType", "entityId", "metadata", "createdAt"],
  });
  const peopleIds = [...new Set(events.filter(e => ["admin", "partner"].includes(e.actorType) && e.actorId).map(e => e.actorId))];
  const people = peopleIds.length ? await AdminUser.findAll({ where: { id: { [Op.in]: peopleIds } }, attributes: ["id", "name", "role"] }) : [];
  const byId = new Map(people.map(u => [String(u.id), u]));
  const actor = (event) => {
    if (!event) return null;
    const user = byId.get(String(event.actorId));
    return { type: event.actorType, id: user?.id ?? event.actorId ?? null,
      name: user?.name ?? event.metadata?.actorName ?? ({device:"Próprio dispositivo",anonymous:"Link público / anônimo",system:"Sistema"}[event.actorType] ?? "Origem não identificada"),
      role: user?.role ?? null, at: event.createdAt, action: event.action };
  };
  const isPlaylist = e => /playlist|configuration.confirm|device.admin.edit|configuration.update/i.test(e.action)
    && !/cancel|remove|pending_applied|self_revoke/i.test(e.action)
    && !(e.action === "device.admin.edit" && !e.metadata?.listName && !e.metadata?.listUrlHost);
  const result = activations.map(row => {
    const own = events.filter(e => e.entityType === "activation" && String(e.entityId) === String(row.id));
    const deviceEvents = events.filter(e => e.entityType === "device" && String(e.entityId) === String(deviceId) && String(e.metadata?.activationId ?? "") === String(row.id));
    const all = [...own, ...deviceEvents].sort((x,y) => new Date(x.createdAt)-new Date(y.createdAt));
    const creation = own.find(e => e.action === "activation.create") ?? null;
    const panelActivation = deviceEvents.find(e => e.action === "device.configuration.confirm" && e.metadata?.added === true);
    const created = panelActivation ?? creation ?? all.find(e => /activation|configuration.confirm/i.test(e.action));
    const configured = all.filter(isPlaylist).at(-1) ?? null;
    return { activationId: row.id, activatedAt: row.activatedAt, status: row.status,
      listName: row.playlistName, activatedBy: actor(created), listAddedBy: actor(configured),
      lastChangedBy: actor(all.filter(e => !/register|lookup/.test(e.action)).at(-1) ?? null) };
  });
  return { deviceId, mac: device.mac, activations: result };
}
