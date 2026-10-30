import { Op, UniqueConstraintError } from "sequelize";
import {
  sequelize, Device, Activation, License, Partner, PartnerCode, PartnerProvider, WebAccess, Renewal, LicenseEvent,
} from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { encryptSecret, decryptSecret, hashCode, generateCode } from "../../shared/crypto.js";
import { addLicenseMonthsUTC } from "../../shared/dates.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { checkActivation, denialError, enforceSessionCap, issueSession, revokeSessionsOf } from "../access/access.service.js";
import { dropMirrorAuth, clearMirrorAuth } from "../mirror/mirror.cache.js";
import { deliveryModesOf } from "../mirror/mode.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { activateLicenseById } from "../activations/activation.service.js";
import { applyStockToDevice } from "../stock/stock.service.js";
import { isLiveLicense } from "../stock/stock-license.js";
import * as registration from "../devices/registration.service.js";
import { presenceOf } from "../devices/presence.js";
import { generateWebCode, generateWebMac, normalizeWebCode, WEB_CODE_RE } from "./web-code.js";
import { sanitizeModes, webDefaultModes, MODE_KINDS } from "./web-modes.js";

/**
 * Player Web separado. Um acesso web = um código (AB123456) + um dispositivo web (plataforma 'web', MAC virtual) com a
 * sua própria ativação e licença — licenciado como uma TV. Quem gera o código é o revendedor (do estoque dele) ou o admin.
 *
 * O login por código devolve a MESMA sessão que o app de TV usa (tokens de dispositivo), então catálogo, status, renovação
 * de sessão e o espelho proxy/redirect funcionam sem um segundo sistema de autorização. Bloqueio, expiração e
 * remoção valem na próxima requisição (o espelho revalida a ativação).
 */

const live = { [Op.ne]: "revoked" };
const invalidCode = () => new AppError(401, "INVALID_WEB_CODE", "Código inválido ou expirado.");
const webHash = (code) => hashCode(`WEB${code}`); // prefixo separa o "espaço" dos códigos web do das licenças
const compact = (mac) => mac.replaceAll(":", "");
const installationIdOf = (mac) => `webtv-${compact(mac)}`;
const defaultModes = () => webDefaultModes(process.env.WEB_DELIVERY_DEFAULTS);

/* ------------------------------------------------------------------ leitura */

const includeFor = [
  { model: Device, attributes: ["id", "mac", "lastSeenAt"] },
  { model: Partner, attributes: ["id", "name"] },
];

async function liveActivationOf(deviceId, transaction) {
  return Activation.findOne({
    where: { deviceId, status: live }, order: [["activatedAt", "DESC"]], transaction,
    include: [{ model: PartnerProvider, attributes: ["id", "name", "deliveryMode", "status"], required: false }],
  });
}

async function serialize(wa) {
  const activation = await liveActivationOf(wa.deviceId);
  let access = null;
  let license = null;
  const provider = activation?.PartnerProvider ? { id: activation.PartnerProvider.id, name: activation.PartnerProvider.name } : null;
  if (activation) {
    const { decision } = await checkActivation(activation.id);
    access = { allowed: decision.allowed, code: decision.code, message: decision.message };
    const licId = activation.grantedLicenseId ?? activation.licenseId;
    const lic = licId ? await License.findByPk(licId) : null;
    if (lic) license = { id: lic.id, status: lic.status, expiresAt: lic.expiresAt, startsAt: lic.startsAt };
    if (!license && decision.expiresAt) license = { id: null, status: "partner", expiresAt: decision.expiresAt, startsAt: null };
  }
  const pres = presenceOf(wa.deviceId, wa.Device?.lastSeenAt);
  return {
    id: wa.id,
    code: decryptSecret(wa.codeEnc), // o dono (revendedor/admin) pode consultar o código de novo
    label: wa.label ?? null,
    status: wa.status,
    statusReason: wa.statusReason ?? null,
    partner: wa.Partner ? { id: wa.Partner.id, name: wa.Partner.name } : null,
    mac: wa.Device?.mac ?? null,
    createdAt: wa.createdAt,
    lastLoginAt: wa.lastLoginAt,
    online: pres.online,
    lastSeenAt: pres.lastSeenAt,
    configured: !!activation && !!(activation.providerId || activation.playlistUrlEnc),
    activationId: activation?.id ?? null,
    listName: activation?.playlistName ?? null,
    provider,
    license,
    access,
    // Efetivo (o que o espelho aplica) e o que foi sobrescrito neste acesso.
    deliveryModes: activation ? deliveryModesOf(activation) : null,
    deliveryOverrides: sanitizeModes(activation?.deliveryModes),
  };
}

export async function listWebAccesses({ q, status, partnerId, page, pageSize }, scope = {}) {
  const where = {};
  const owner = scope.partnerId ?? partnerId;
  if (owner) where.partnerId = owner;
  if (status) where.status = status;
  if (q) {
    const term = String(q).trim();
    const code = normalizeWebCode(term);
    where[Op.or] = [
      { label: { [Op.iLike]: `%${term.replace(/[%_\\]/g, "\\$&")}%` } },
      ...(code ? [{ codeHash: webHash(code) }] : []),
    ];
  }
  const { rows, count } = await WebAccess.findAndCountAll({
    where, include: includeFor, order: [["createdAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true,
  });
  return paged(await Promise.all(rows.map(serialize)), count, { page, pageSize });
}

async function loadOwned(id, scope = {}) {
  const where = { id };
  if (scope.partnerId) where.partnerId = scope.partnerId; // revendedor: id de outro dá 404
  const wa = await WebAccess.findOne({ where, include: includeFor });
  if (!wa) throw notFound("Acesso web");
  return wa;
}

export async function getWebAccess(id, scope = {}) {
  return serialize(await loadOwned(id, scope));
}

/* ------------------------------------------------------------------ criação */

/** Lista (configuração) a copiar de uma ativação que já existe, SEM expor usuário/senha a quem copia. */
export async function configFromActivation(activation) {
  if (activation.playlistUrlEnc) {
    return { mode: "playlist", name: activation.playlistName || "Minha lista", url: decryptSecret(activation.playlistUrlEnc) };
  }
  if (activation.providerId && activation.credentialsEnc && activation.partnerCodeId) {
    const code = await PartnerCode.findByPk(activation.partnerCodeId);
    if (!code) throw new AppError(409, "SOURCE_CODE_GONE", "O código de parceria desta lista não existe mais.");
    const { username, password } = JSON.parse(decryptSecret(activation.credentialsEnc));
    return { mode: "partner", code: code.code, username, password };
  }
  throw new AppError(409, "SOURCE_NOT_COPYABLE", "Este dispositivo não tem uma lista que possa ser copiada.");
}

/** Cria o dispositivo web + o registro do acesso (código único). Repete se o sorteio colidir. */
async function createRecord({ partner, actor, label }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateWebCode();
    const mac = generateWebMac();
    try {
      return await sequelize.transaction(async (t) => {
        const device = await Device.create({
          mac, platform: "web", appId: "delta-tv-web", identifierType: "virtual_mac", deviceKey: `web:${mac}`,
          lastInstallationId: installationIdOf(mac), firstRegisteredAt: new Date(),
        }, { transaction: t });
        const wa = await WebAccess.create({
          partnerId: partner?.id ?? null, deviceId: device.id, codeHash: webHash(code), codeEnc: encryptSecret(code),
          label: label ?? null, createdBy: actor?.id ?? null,
        }, { transaction: t });
        await audit({
          actor, action: "web_access.create", entityType: "web_access", entityId: wa.id,
          metadata: { mac, partnerId: partner?.id ?? null, label: label ?? null }, transaction: t,
        });
        return { wa, device, code };
      });
    } catch (e) {
      if (!(e instanceof UniqueConstraintError)) throw e;
    }
  }
  throw new AppError(503, "CODE_GENERATION_FAILED", "Não foi possível gerar um código único. Tente novamente.");
}

/** Licença de cortesia do ADMIN (sem mexer no estoque de ninguém): cria a licença e a ativa no dispositivo web. */
async function grantCourtesyLicense({ partner, actor, device, months }) {
  return sequelize.transaction(async (t) => {
    const plan = await ensurePlan(months, { transaction: t });
    const now = new Date();
    const code = generateCode("LIC");
    const license = await License.create({
      codeHash: hashCode(code), codeLast4: code.slice(-4), planId: plan.id, status: "pending", maxDevices: plan.maxDevices,
      ownerPartnerId: partner?.id ?? null, assignedAt: now, createdBy: actor.id ?? null, notes: "Cortesia do administrador (acesso web)",
    }, { transaction: t });
    const r = await activateLicenseById({
      licenseId: license.id, mac: device.mac, installationId: device.lastInstallationId,
      meta: { ip: actor.ip, userAgent: "admin-web-access" }, transaction: t,
    });
    await LicenseEvent.create({
      licenseId: license.id, partnerId: partner?.id ?? null, event: "activated", toDeviceId: device.id,
      actorType: actor.type ?? "admin", actorId: actor.id ?? null, metadata: { months, courtesy: true, activationId: r.activation.id },
    }, { transaction: t });
    return r;
  });
}

/**
 * Gera um acesso web.
 *  - `config`: { mode: "partner", code, username, password } (servidor do parceiro)  |  { mode: "playlist", name, url } (lista própria)
 *  - `months`: duração da licença. Obrigatória no modo "playlist". No modo "partner" a licença é a do CÓDIGO (como numa TV).
 *  - `useStock`: consome 1 licença do estoque do `partner` (revendedor). Admin pode desmarcar (cortesia).
 *  - `modes`: override de proxy/redirect por tipo; o restante segue os padrões do web.
 */
export async function createWebAccess({ partner = null, actor, label, config, months, useStock = true, modes }) {
  if (!config) throw new AppError(422, "CONFIG_REQUIRED", "Informe a lista (servidor ou link) deste acesso.");
  if (config.mode === "playlist") {
    if (!months) throw new AppError(422, "MONTHS_REQUIRED", "Informe a duração da licença.");
    await assertPublicUrl(config.url); // valida ANTES de gastar licença
  }
  if (useStock && !partner) throw new AppError(422, "PARTNER_REQUIRED", "Para usar o estoque, escolha o revendedor.");

  const { wa, device, code } = await createRecord({ partner, actor, label });
  let licenseSpent = false;
  try {
    if (config.mode === "playlist") {
      if (useStock) await applyStockToDevice({ partner, actor, device, months });
      else await grantCourtesyLicense({ partner, actor, device, months });
      licenseSpent = true;
      await registration.configureDeviceByAdmin(device.id, { mode: "playlist", confirm: true, name: config.name, url: config.url }, actor);
    } else {
      // O servidor do parceiro valida o código + usuário/senha no provedor; a licença (se houver) é a do código.
      await registration.configureDeviceByAdmin(device.id, {
        mode: "partner", confirm: true, code: config.code, username: config.username, password: config.password,
      }, actor);
      licenseSpent = true; // pode ter consumido o estoque do código: não apaga o acesso se algo falhar depois
    }
    const activation = await liveActivationOf(device.id);
    if (!activation) throw new AppError(500, "ACTIVATION_MISSING", "A lista não foi vinculada. Tente novamente.");
    await activation.update({ deliveryModes: { ...defaultModes(), ...sanitizeModes(modes) } });
    dropMirrorAuth(activation.id);
  } catch (e) {
    if (!licenseSpent) {
      // Nada foi cobrado: desfaz o acesso (a exclusão do dispositivo leva o registro junto).
      await Device.destroy({ where: { id: device.id } }).catch(() => {});
    }
    throw e;
  }
  return { ...(await serialize(await loadOwned(wa.id))), code };
}

/* ------------------------------------------------------------------ gestão */

const BLOCK_RULES = {
  block: { from: ["active"], to: "blocked" },
  unblock: { from: ["blocked"], to: "active" },
  revoke: { from: ["active", "blocked"], to: "revoked" },
};

/** block / unblock / revoke. `role`: "partner" | "admin" (o revendedor não desfaz bloqueio da plataforma nem joga fora licença em vigor). */
export async function changeStatus(id, action, { reason, actor, scope = {}, role }) {
  const rule = BLOCK_RULES[action];
  if (!rule) throw new AppError(400, "INVALID_ACTION", "Ação inválida.");
  if (action === "block" && !reason) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo do bloqueio.");

  const activationId = await sequelize.transaction(async (t) => {
    const where = { id };
    if (scope.partnerId) where.partnerId = scope.partnerId;
    const wa = await WebAccess.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
    if (!wa) throw notFound("Acesso web");
    if (!rule.from.includes(wa.status)) throw new AppError(409, "INVALID_STATE", `Não é possível executar '${action}' em um acesso '${wa.status}'.`);
    const a = await liveActivationOf(wa.deviceId, t);

    if (action === "unblock" && role === "partner" && a?.blockedBy && a.blockedBy !== "partner") {
      throw new AppError(403, "BLOCKED_BY_PLATFORM", "Este bloqueio foi aplicado pela plataforma.");
    }
    if (action === "revoke" && role === "partner" && a) {
      const licId = a.grantedLicenseId ?? a.licenseId;
      if (licId && isLiveLicense(await License.findByPk(licId, { transaction: t }))) {
        throw new AppError(409, "LICENSE_ACTIVE", "Este acesso tem uma licença em andamento. Use Bloquear: remover perderia o tempo restante.");
      }
    }

    await wa.update({ status: rule.to, statusReason: action === "unblock" ? null : (reason ?? null) }, { transaction: t });
    if (a) {
      const patch = { status: rule.to === "revoked" ? "revoked" : rule.to };
      if (action === "block") Object.assign(patch, { statusReason: reason, blockedBy: role });
      if (action === "unblock") Object.assign(patch, { statusReason: null, blockedBy: null });
      if (action === "revoke") Object.assign(patch, { revokedAt: new Date(), statusReason: reason ?? "Acesso web removido", credentialsEnc: null });
      await a.update(patch, { transaction: t });
      if (action !== "unblock") await revokeSessionsOf(a.id, t); // derruba os navegadores já logados
    }
    await audit({ actor, action: `web_access.${action}`, entityType: "web_access", entityId: wa.id, metadata: { reason: reason ?? null, role }, transaction: t });
    return a?.id ?? null;
  });
  if (activationId) dropMirrorAuth(activationId);
  return getWebAccess(id, scope);
}

/** Renovação: 1 licença do estoque do dono (ou cortesia do admin) soma `months` ao prazo. */
export async function renew(id, { months, actor, scope = {}, useStock = true }) {
  const wa = await loadOwned(id, scope);
  if (wa.status === "revoked") throw new AppError(409, "INVALID_STATE", "Este acesso foi removido.");
  const activation = await liveActivationOf(wa.deviceId);
  const licId = activation?.grantedLicenseId ?? activation?.licenseId;
  if (!activation || !licId) {
    throw new AppError(409, "NO_LICENSE", "Este acesso não tem licença própria para renovar (o prazo é o do servidor/código).");
  }
  const device = wa.Device;
  if (useStock) {
    const partner = wa.Partner ? await Partner.findByPk(wa.partnerId) : null;
    if (!partner) throw new AppError(422, "PARTNER_REQUIRED", "Este acesso não tem revendedor: renove como cortesia.");
    await applyStockToDevice({ partner, actor, device, months });
  } else {
    await sequelize.transaction(async (t) => {
      const lic = await License.findByPk(licId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!lic || ["cancelled", "blocked"].includes(lic.status)) throw new AppError(409, "NOT_RENEWABLE", "A licença está cancelada ou bloqueada.");
      const plan = await ensurePlan(months, { transaction: t });
      const now = new Date();
      const base = lic.expiresAt && lic.expiresAt > now ? lic.expiresAt : now;
      const expiresAt = addLicenseMonthsUTC(base, months);
      const previous = lic.expiresAt;
      await lic.update({ planId: plan.id, expiresAt, startsAt: lic.startsAt ?? now, status: lic.status === "pending" ? "active" : lic.status }, { transaction: t });
      await Renewal.create({ licenseId: lic.id, planId: plan.id, previousExpiresAt: previous, newExpiresAt: expiresAt, createdBy: actor.id ?? null }, { transaction: t });
      await audit({ actor, action: "web_access.renew", entityType: "web_access", entityId: wa.id, metadata: { months, courtesy: true, expiresAt }, transaction: t });
    });
    clearMirrorAuth();
  }
  return getWebAccess(id, scope);
}

/** Nome do acesso e/ou modo de entrega por tipo. `deliveryModes: null` volta aos padrões do web. */
export async function updateWebAccess(id, { label, deliveryModes }, { actor, scope = {} }) {
  const wa = await loadOwned(id, scope);
  if (wa.status === "revoked") throw new AppError(409, "INVALID_STATE", "Este acesso foi removido.");
  const changes = {};
  if (label !== undefined) { await wa.update({ label }); changes.label = label; }
  if (deliveryModes !== undefined) {
    const activation = await liveActivationOf(wa.deviceId);
    if (!activation) throw new AppError(409, "NOT_CONFIGURED", "Este acesso ainda não tem lista configurada.");
    const next = deliveryModes === null ? { ...defaultModes() } : { ...defaultModes(), ...sanitizeModes(deliveryModes) };
    await activation.update({ deliveryModes: next });
    dropMirrorAuth(activation.id);
    changes.deliveryModes = next;
  }
  if (!Object.keys(changes).length) throw new AppError(422, "NOTHING_TO_CHANGE", "Nenhuma alteração informada.");
  await audit({ actor, action: "web_access.update", entityType: "web_access", entityId: wa.id, metadata: changes });
  return getWebAccess(id, scope);
}

/* ------------------------------------------------------------------ login do cliente */

const stateOf = (a) => (a.licenseId && a.playlistUrlEnc ? "configured_playlist" : a.partnerId && a.providerId ? "configured_partner" : "awaiting_configuration");

/**
 * Login do Player Web pelo código. Devolve a sessão no mesmo formato da ativação das TVs. Qualquer código que não exista
 * (ou tenha sido removido) responde igual; bloqueio/expiração têm mensagem própria (o cliente precisa saber o que fazer).
 */
export async function loginWithCode({ code, ip, userAgent }) {
  const norm = normalizeWebCode(code);
  if (!norm) throw invalidCode();
  const wa = await WebAccess.findOne({ where: { codeHash: webHash(norm) }, include: [{ model: Device, attributes: ["id", "mac"] }] });
  if (!wa || wa.status === "revoked") {
    await audit({ actor: { type: "anonymous", ip }, action: "web_access.login", entityType: "web_access", entityId: wa?.id ?? null, result: "denied", metadata: { reason: wa ? "revoked" : "unknown" } });
    throw invalidCode();
  }
  const outcome = await sequelize.transaction(async (t) => {
    const activation = await Activation.findOne({ where: { deviceId: wa.deviceId, status: { [Op.ne]: "revoked" } }, transaction: t, lock: t.LOCK.UPDATE });
    if (!activation) return { error: new AppError(409, "WEB_ACCESS_NOT_CONFIGURED", "Este acesso ainda não tem lista configurada. Contate seu fornecedor.") };
    const { decision } = await checkActivation(activation.id, { transaction: t });
    if (wa.status === "blocked" || !decision.allowed) {
      await audit({ actor: { type: "anonymous", ip }, action: "web_access.login", entityType: "web_access", entityId: wa.id, result: "denied", metadata: { code: decision.code ?? "BLOCKED" }, transaction: t });
      return { error: wa.status === "blocked" ? new AppError(403, "WEB_ACCESS_BLOCKED", "Acesso bloqueado. Contate seu fornecedor.") : denialError(decision) };
    }
    await enforceSessionCap(activation.id, t);
    const session = await issueSession(activation, { ip, userAgent }, t);
    await wa.update({ lastLoginAt: new Date() }, { transaction: t });
    await Device.update({ lastSeenAt: new Date() }, { where: { id: wa.deviceId }, transaction: t });
    await audit({ actor: { type: "device", id: activation.id, ip }, action: "web_access.login", entityType: "web_access", entityId: wa.id, metadata: { mac: wa.Device.mac }, transaction: t });
    return { activation, session, decision };
  });
  if (outcome.error) throw outcome.error;
  const { activation, session, decision } = outcome;
  return {
    mac: wa.Device.mac,
    installationId: installationIdOf(wa.Device.mac), // o app deriva o mesmo valor: "webtv-<MAC>"
    activationId: activation.id,
    kind: activation.licenseId ? "license" : "partner",
    status: "active",
    configurationStatus: stateOf(activation),
    expiresAt: decision.expiresAt,
    listName: activation.playlistName ?? null,
    tokens: { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn },
  };
}

export { MODE_KINDS, WEB_CODE_RE };
