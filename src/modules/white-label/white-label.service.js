import { createHash } from "node:crypto";
import { signJwt, verifyJwt } from "../../shared/crypto.js";
import { Op } from "sequelize";
import {
  sequelize, Partner, WhiteLabelApp, WhiteLabelAppServer,
  WhiteLabelAppActivation, WhiteLabelAppPayment,
} from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { paged, pageOf } from "../../shared/pagination.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { probeAccount, xtreamOrigin } from "../xtream/xtream.service.js";

import { utcDay, extendMonthlyAccess, effectiveAppState } from "./white-label.rules.js";
const WHITE_LABEL_SESSION_TTL = 20 * 60; // autorização curta; o player precisa renovar durante o uso
const WHITE_LABEL_RECHECK_SECONDS = 5 * 60;
const WHITE_LABEL_REAUTH_SECONDS = 24 * 60 * 60; // rever a conta Xtream ao menos uma vez por dia
function sessionTokenFor(app, activation, authAt = Math.floor(Date.now() / 1000)) {
  return signJwt({ typ: "white_label_app", appId: app.id, activationId: activation.id, authAt }, WHITE_LABEL_SESSION_TTL);
}

const appSummary = (app, count = 0, partnerStatus = "active") => ({
  id: app.id, partnerId: app.partnerId, appKey: app.appKey, name: app.name,
  logoUrl: app.logoUrl, downloadUrl: app.downloadUrl,
  status: app.status, appearanceEnabled: !!app.appearanceEnabled, effectiveStatus: effectiveAppState(app, partnerStatus),
  planType: app.planType, activationLimit: app.activationLimit,
  activeActivations: count, availableActivations: app.planType === "unlimited" ? null : Math.max(0, app.activationLimit - count),
  monthlyFeeCents: app.monthlyFeeCents, paidThrough: app.paidThrough,
  createdAt: app.createdAt, updatedAt: app.updatedAt,
});

async function countActive(appId, transaction) {
  return WhiteLabelAppActivation.count({ where: { appId, status: "active" }, transaction });
}
async function getOwned(id, partnerId, { transaction, lock } = {}) {
  const where = { id, ...(partnerId ? { partnerId } : {}) };
  const app = await WhiteLabelApp.findOne({ where, transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (!app) throw notFound("Aplicativo");
  return app;
}
async function checkedApp(id, partnerId, options = {}) {
  const app = await getOwned(id, partnerId, options);
  const partner = await Partner.findByPk(app.partnerId, { transaction: options.transaction });
  if (!partner) throw notFound("Contratante");
  return { app, partner };
}
export async function createApp(input, actor) {
  const partner = await Partner.findByPk(input.partnerId);
  if (!partner || partner.status === "deleted") throw notFound("Parceiro ou revenda");
  return sequelize.transaction(async (transaction) => {
    const app = await WhiteLabelApp.create({ ...input,
      planType: input.planType ?? "limited",
      activationLimit: input.planType === "unlimited" ? null : input.activationLimit,
      status: input.status ?? "draft",
    }, { transaction });
    await audit({ actor, action: "white-label.create", entityType: "white_label_app", entityId: app.id,
      metadata: { partnerId: app.partnerId, appKey: app.appKey, planType: app.planType }, transaction });
    return appSummary(app, 0, partner.status);
  });
}
export async function listApps({ page, pageSize, partnerId, q } = {}) {
  const where = { ...(partnerId ? { partnerId } : {}) };
  if (q) where[Op.or] = [
    { name: { [Op.iLike]: `%${q}%` } }, { appKey: { [Op.iLike]: `%${q}%` } },
  ];
  const { rows, count } = await WhiteLabelApp.findAndCountAll({ where,
    include: [{ model: Partner, attributes: ["id", "name", "kind", "status"] }],
    order: [["createdAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true });
  const data = await Promise.all(rows.map(async (app) => ({
    ...appSummary(app, await countActive(app.id), app.Partner?.status),
    partnerName: app.Partner?.name, partnerKind: app.Partner?.kind,
  })));
  return paged(data, count, { page, pageSize });
}
export async function getApp(id, partnerId) {
  const { app, partner } = await checkedApp(id, partnerId);
  return { ...appSummary(app, await countActive(id), partner.status),
    partnerName: partner.name, notes: partnerId ? undefined : app.notes };
}
export async function updateApp(id, input, actor) {
  return sequelize.transaction(async (transaction) => {
    const { app, partner } = await checkedApp(id, null, { transaction, lock: true });
    const nextType = input.planType ?? app.planType;
    const nextLimit = nextType === "unlimited" ? null : input.activationLimit ?? app.activationLimit;
    if (nextType === "limited" && (!Number.isInteger(nextLimit) || nextLimit < 1))
      throw new AppError(422, "ACTIVATION_LIMIT_REQUIRED", "Informe o limite de ativações do plano.");
    if (nextType === "limited" && nextLimit < await countActive(id, transaction))
      throw new AppError(409, "LIMIT_BELOW_USAGE", "O limite não pode ser menor que o número de aparelhos ativos.");
    const fields = { ...input, planType: nextType, activationLimit: nextLimit };
    await app.update(fields, { transaction });
    await audit({ actor, action: "white-label.update", entityType: "white_label_app", entityId: app.id,
      metadata: { fields: Object.keys(input), status: app.status, planType: app.planType, activationLimit: nextLimit }, transaction });
    return appSummary(app, await countActive(id, transaction), partner.status);
  });
}
export async function addServer(appId, partnerId, input, actor) {
  const { app } = await checkedApp(appId, partnerId);
  if (app.status === "archived") throw new AppError(409, "APP_ARCHIVED", "Aplicativo arquivado.");
  const baseUrl = xtreamOrigin(input.baseUrl);
  await assertPublicUrl(baseUrl);
  return sequelize.transaction(async (transaction) => {
    const server = await WhiteLabelAppServer.create({ appId, name: input.name,
      baseUrl, priority: input.priority ?? 0, status: input.status ?? "active" }, { transaction });
    await audit({ actor, action: "white-label.server.create", entityType: "white_label_app", entityId: appId,
      metadata: { serverId: server.id }, transaction });
    return server;
  });
}
export async function editServer(appId, serverId, partnerId, input, actor) {
  await checkedApp(appId, partnerId);
  const fields = { ...input };
  if (input.baseUrl != null) {
    fields.baseUrl = xtreamOrigin(input.baseUrl);
    await assertPublicUrl(fields.baseUrl);
  }
  return sequelize.transaction(async (transaction) => {
    const server = await WhiteLabelAppServer.findOne({ where: { id: serverId, appId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!server) throw notFound("Servidor");
    await server.update(fields, { transaction });
    await audit({ actor, action: "white-label.server.update", entityType: "white_label_app", entityId: appId,
      metadata: { serverId, fields: Object.keys(fields) }, transaction });
    return server;
  });
}
export async function removeServer(appId, serverId, partnerId, actor) {
  await checkedApp(appId, partnerId);
  return sequelize.transaction(async (transaction) => {
    const server = await WhiteLabelAppServer.findOne({ where: { id: serverId, appId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!server) throw notFound("Servidor");
    await server.destroy({ transaction });
    await audit({ actor, action: "white-label.server.delete", entityType: "white_label_app", entityId: appId,
      metadata: { serverId }, transaction });
  });
}
export async function listServers(appId, partnerId) {
  await checkedApp(appId, partnerId);
  return WhiteLabelAppServer.findAll({ where: { appId }, order: [["priority", "ASC"], ["createdAt", "ASC"]] });
}
export async function listActivations(appId, partnerId, { page = 1, pageSize = 20 } = {}) {
  await checkedApp(appId, partnerId);
  const { rows, count } = await WhiteLabelAppActivation.findAndCountAll({ where: { appId },
    attributes: ["id", "platform", "status", "activatedAt", "lastSeenAt", "revokedAt"],
    order: [["activatedAt", "DESC"]], ...pageOf({ page, pageSize }) });
  return paged(rows, count, { page, pageSize });
}
export async function changeActivation(appId, activationId, partnerId, action, actor) {
  return sequelize.transaction(async (transaction) => {
    const { app } = await checkedApp(appId, partnerId, { transaction, lock: true });
    const record = await WhiteLabelAppActivation.findOne({ where: { id: activationId, appId }, transaction,
      lock: transaction.LOCK.UPDATE });
    if (!record) throw notFound("Ativação");
    if (action === "restore") {
      if (record.status !== "active") {
        const used = await countActive(appId, transaction);
        if (app.planType === "limited" && used >= app.activationLimit)
          throw new AppError(409, "ACTIVATION_LIMIT", "Limite de aparelhos alcançado.");
      }
      await record.update({ status: "active", revokedAt: null }, { transaction });
    } else {
      await record.update({ status: "revoked", revokedAt: new Date() }, { transaction });
    }
    await audit({ actor, action: `white-label.activation.${action}`, entityType: "white_label_app", entityId: appId,
      metadata: { activationId }, transaction });
    return { id: record.id, status: record.status };
  });
}
export async function recordPayment(appId, input, actor) {
  return sequelize.transaction(async (transaction) => {
    const app = await getOwned(appId, null, { transaction, lock: true });
    if (app.status === "archived") throw new AppError(409, "APP_ARCHIVED", "Não é possível receber por um aplicativo arquivado.");
    const previous = await WhiteLabelAppPayment.findOne({ where: { appId, reference: input.reference }, transaction });
    if (previous) {
      // Uma referência repetida só é idempotente quando representa a MESMA quitação.
      // Não aceitar uma segunda quantia ou duração sob o mesmo comprovante.
      if (previous.months !== input.months || previous.amountCents !== input.amountCents)
        throw new AppError(409, "PAYMENT_REFERENCE_CONFLICT", "Esta referência de pagamento já foi usada com outros valores ou meses.");
      return { payment: previous, duplicate: true };
    }
    const paidThrough = extendMonthlyAccess(app.paidThrough, input.months);
    const payment = await WhiteLabelAppPayment.create({ appId, reference: input.reference,
      months: input.months, amountCents: input.amountCents, notes: input.notes,
      previousPaidThrough: app.paidThrough, paidThrough, createdBy: actor.id }, { transaction });
    await app.update({ paidThrough }, { transaction });
    await audit({ actor, action: "white-label.payment.manual", entityType: "white_label_app", entityId: appId,
      metadata: { reference: input.reference, months: input.months, amountCents: input.amountCents, paidThrough }, transaction });
    return { payment, duplicate: false, paidThrough };
  });
}
export async function listPayments(appId, partnerId) {
  await checkedApp(appId, partnerId);
  return WhiteLabelAppPayment.findAll({ where: { appId }, order: [["paidAt", "DESC"]], limit: 100,
    attributes: ["id", "reference", "months", "amountCents", "paidThrough", "notes", "paidAt"] });
}

/**
 * Login de dispositivo. Recebe credenciais somente em memória para verificar o Xtream.
 * NUNCA grava username/password/M3U. O app preserva as credenciais localmente e consulta o servidor IPTV direto.
 * A instalação deve gerar e persistir um UUID aleatório no primeiro uso.
 */
export async function activateByXtream(appKey, { installationId, username, password, platform }) {
  const app = await WhiteLabelApp.findOne({ where: { appKey } });
  if (!app) throw notFound("Aplicativo");
  const partner = await Partner.findByPk(app.partnerId);
  if (effectiveAppState(app, partner?.status) !== "active")
    throw new AppError(403, "APP_SUBSCRIPTION_INACTIVE", "Aplicativo indisponível. Contate o responsável pelo serviço.");
  const servers = await WhiteLabelAppServer.findAll({ where: { appId: app.id, status: "active" },
    order: [["priority", "ASC"], ["createdAt", "ASC"]] });
  if (!servers.length) throw new AppError(503, "NO_SERVERS", "O responsável ainda não configurou servidores para o aplicativo.");
  let selected = null;
  let account = null;
  let invalid = 0;
  // Não usar host informado pelo aparelho: somente URLs cadastradas pelo contratante e verificadas anti-SSRF.
  for (const server of servers.slice(0, 6)) {
    const result = await probeAccount({ baseUrl: server.baseUrl, username, password });
    if (result.ok) { selected = server; account = result.account; break; }
    if (result.reason === "invalid") invalid++;
  }
  if (!selected) {
    const validAttempts = Math.min(servers.length, 6);
    if (invalid === validAttempts) throw new AppError(403, "XTREAM_INVALID", "Usuário ou senha inválidos no servidor cadastrado.");
    throw new AppError(503, "XTREAM_UNAVAILABLE", "Nenhum servidor confirmou a conta neste momento.");
  }
  const installationHash = createHash("sha256").update(`${app.id}\0${installationId}`).digest("hex");
  const activation = await sequelize.transaction(async (transaction) => {
    // Trava a LINHA DO APP antes de contar as vagas: duas TVs simultâneas não ultrapassam o limite.
    const locked = await WhiteLabelApp.findByPk(app.id, { transaction, lock: transaction.LOCK.UPDATE });
    const currentPartner = await Partner.findByPk(app.partnerId, { transaction });
    if (effectiveAppState(locked, currentPartner?.status) !== "active")
      throw new AppError(403, "APP_SUBSCRIPTION_INACTIVE", "Assinatura indisponível.");
    let existing = await WhiteLabelAppActivation.findOne({ where: { appId: app.id, installationHash },
      transaction, lock: transaction.LOCK.UPDATE });
    if (existing?.status === "revoked") throw new AppError(403, "DEVICE_REVOKED", "Este aparelho foi removido pelo administrador.");
    if (!existing) {
      const used = await countActive(app.id, transaction);
      if (locked.planType === "limited" && used >= locked.activationLimit)
        throw new AppError(409, "ACTIVATION_LIMIT", "O plano do aplicativo atingiu o limite de ativações.");
      existing = await WhiteLabelAppActivation.create({ appId: app.id, installationHash, platform,
        status: "active", activatedAt: new Date(), lastSeenAt: new Date() }, { transaction });
    } else {
      // Telemetria econômica: atualiza a última sessão só se passaram 5 minutos.
      if (!existing.lastSeenAt || Date.now() - new Date(existing.lastSeenAt).getTime() > 300_000)
        await existing.update({ lastSeenAt: new Date(), platform }, { transaction });
    }
    return existing;
  });
  // Retorna os servidores cadastrados (sem credenciais) para fallback no PLAYER.
  return { app: { name: app.name, appKey: app.appKey, logoUrl: app.logoUrl },
    activation: { id: activation.id, status: activation.status, planType: app.planType },
    account, selectedBaseUrl: selected.baseUrl,
    servers: [selected, ...servers.filter(s => s.id !== selected.id)].map(s => ({ name: s.name, baseUrl: s.baseUrl })),
    expiresAt: app.paidThrough, sessionToken: sessionTokenFor(app, activation),
    refreshAfterSeconds: WHITE_LABEL_RECHECK_SECONDS };
}

/**
 * Heartbeat leve: valida o contrato e a ativação SEM receber novamente usuário/senha Xtream.
 * O player é responsável por interromper a reprodução se a validação falhar ou o token expirar.
 */
export async function validateAppSession(appKey, sessionToken) {
  const payload = verifyJwt(sessionToken, "white_label_app");
  const app = await WhiteLabelApp.findOne({ where: { appKey } });
  if (!app || payload.appId !== app.id) throw new AppError(401, "INVALID_TOKEN", "Sessão do aplicativo inválida.");
  if (!Number.isInteger(payload.authAt) || Math.floor(Date.now() / 1000) - payload.authAt >= WHITE_LABEL_REAUTH_SECONDS)
    throw new AppError(401, "REAUTH_REQUIRED", "Valide novamente seu usuário e senha IPTV.");
  const partner = await Partner.findByPk(app.partnerId);
  if (effectiveAppState(app, partner?.status) !== "active")
    throw new AppError(403, "APP_SUBSCRIPTION_INACTIVE", "Assinatura do aplicativo indisponível.");
  const activation = await WhiteLabelAppActivation.findOne({ where: { id: payload.activationId, appId: app.id, status: "active" } });
  if (!activation) throw new AppError(403, "DEVICE_REVOKED", "Ativação deste aparelho não está autorizada.");
  if (!activation.lastSeenAt || Date.now() - new Date(activation.lastSeenAt).getTime() > 300_000)
    await activation.update({ lastSeenAt: new Date() });
  return { authorized: true, sessionToken: sessionTokenFor(app, activation, payload.authAt),
    refreshAfterSeconds: WHITE_LABEL_RECHECK_SECONDS, expiresAt: app.paidThrough };
}
export async function publicAppInfo(appKey) {
  const app = await WhiteLabelApp.findOne({ where: { appKey }, attributes: ["name", "appKey", "logoUrl", "status"] });
  if (!app || app.status === "archived") throw notFound("Aplicativo");
  return { name: app.name, appKey: app.appKey, logoUrl: app.logoUrl };
}
