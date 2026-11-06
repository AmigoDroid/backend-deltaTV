import { randomUUID } from "node:crypto";
import { getPlatformSettings } from "../settings/platform-settings.service.js";
import { env } from "../../config/env.js";
import { Op, UniqueConstraintError } from "sequelize";
import {
  sequelize, Device, Activation, License, Partner, PartnerCode, PartnerProvider, WebAccess, Renewal, LicenseEvent, AdminUser,
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
import { activateLicenseById, preparePartnerActivation, activatePrepared } from "../activations/activation.service.js";
import { termsFor } from "../content-commerce/commerce.service.js";
import { STOCK_KINDS } from "../stock/stock-ledger.js";
import { normalizeShortCode } from "../partners/short-code.js";
import { webIssuePolicy } from "./issuance-policy.js";
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
const defaultModes = async () => (await getPlatformSettings()).web.deliveryModes;

/* ------------------------------------------------------------------ leitura */

const includeFor = [
  { model: Device, attributes: ["id", "mac", "lastSeenAt"] },
  { model: Partner, attributes: ["id", "name"] },
  { model: Partner, as:"contentOwner", attributes:["id","name","kind"] },
  { model: PartnerCode, as:"sourceCode", attributes:["id","code","label"] },
  { model: AdminUser, as:"issuerUser", attributes:["id","name","email"] },
];

async function liveActivationOf(deviceId, transaction) {
  return Activation.findOne({
    where: { deviceId, status: live, [Op.or]: [{ providerId: { [Op.ne]: null } }, { playlistUrlEnc: { [Op.ne]: null } }] }, order: [["activatedAt", "DESC"]], transaction,
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
    issuedBy: wa.Partner ? {id:wa.Partner.id,name:wa.Partner.name} : null,
    contentOwner: wa.contentOwner ? {id:wa.contentOwner.id,name:wa.contentOwner.name,kind:wa.contentOwner.kind} : null,
    partnershipCode: wa.sourceCode?.code ?? null,
    creatorUserId:wa.createdBy ?? null,
    creator:wa.issuerUser ? {id:wa.issuerUser.id,name:wa.issuerUser.name,email:wa.issuerUser.email} : null,
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
    deliveryModes: activation ? deliveryModesOf({ ...activation.toJSON(), Device: { platform: "web" } }) : null,
    gatewayManaged: env.nginxMediaProxy,
    deliveryOverrides: sanitizeModes(activation?.deliveryModes),
  };
}

export async function listWebAccesses({ q, status, partnerId, page, pageSize }, scope = {}) {
  const where = {};
  const owner = scope.partnerId ?? partnerId;
  if (owner) where.partnerId = owner;
  if (scope.contentOwnerPartnerId) where[Op.and]=[{[Op.or]:[{contentOwnerPartnerId:scope.contentOwnerPartnerId},{partnerId:scope.contentOwnerPartnerId,contentOwnerPartnerId:null}]}];
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
  if (scope.contentOwnerPartnerId) where[Op.and]=[{[Op.or]:[{contentOwnerPartnerId:scope.contentOwnerPartnerId},{partnerId:scope.contentOwnerPartnerId,contentOwnerPartnerId:null}]}];
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
async function createRecord({ partner, actor, label, contentOwnerPartnerId=null, sourcePartnerCodeId=null, issuanceKey=null }) {
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
          label: label ?? null, createdBy: actor?.id ?? null, contentOwnerPartnerId, sourcePartnerCodeId, issuanceKey,
          status: issuanceKey ? "pending" : "active",
        }, { transaction: t });
        await audit({
          actor, action: "web_access.create", entityType: "web_access", entityId: wa.id,
          metadata: { mac, partnerId: partner?.id ?? null, label: label ?? null }, transaction: t,
        });
        return { wa, device, code };
      });
    } catch (e) {
      if (!(e instanceof UniqueConstraintError)) throw e;
      if(issuanceKey && partner?.id){
        const prior=await WebAccess.findOne({where:{partnerId:partner.id,issuanceKey}});
        if(prior)return {wa:prior,device:await Device.findByPk(prior.deviceId),code:decryptSecret(prior.codeEnc),reused:true};
      }
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
    await activation.update({ deliveryModes: { ...(await defaultModes()), ...sanitizeModes(modes) } });
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

/**
 * Simplified issuance: no mandatory reseller/content-partner relationship.
 * The partnership code identifies the content owner and ONLY its contract is charged.
 * For an issuer's own stock code the same activation service debits stock instead.
 */
export async function issueWebByPartnershipCode({issuerPartnerId,actor,code:rawCode,username,password,label,requestKey}){
  const code=normalizeShortCode(rawCode);
  if(!/^[0-9]{4,12}$/.test(code))throw new AppError(422,"INVALID_PARTNERSHIP_CODE","Use o código numérico de parceria (4 a 12 dígitos).");
  const issuer=await Partner.findByPk(issuerPartnerId);
  if(!issuer || !["reseller","both"].includes(issuer.kind) || issuer.status!=="active")
    throw new AppError(403,"ISSUER_INACTIVE","Revenda sem permissão para emitir Player Web.");
  if(requestKey){
    const prior=await WebAccess.findOne({where:{partnerId:issuer.id,issuanceKey:requestKey},include:includeFor});
    if(prior){
      if(prior.status==="pending"){
        const committed=await liveActivationOf(prior.deviceId);
        if(committed){ await prior.update({status:"active"});return getWebAccess(prior.id,{partnerId:issuer.id}); }
        throw new AppError(409,"ISSUANCE_PENDING","Emissão em andamento. Aguarde e consulte novamente.");
      }
      return serialize(prior);
    }
  }
  const source=await PartnerCode.findOne({where:{code}});
  // Uniform denial: do not enumerate other parties' codes.
  if(!source || source.status!=="active" || (source.expiresAt && source.expiresAt<=new Date()))
    throw new AppError(403,"WEB_ISSUANCE_UNAVAILABLE","Código não autorizado para emissão de Player Web.");
  const owner=await Partner.findByPk(source.partnerId);
  const terms=owner?.id!==issuer.id && owner ? await termsFor(owner.id) : null;
  const decision=webIssuePolicy({issuer,owner,code:source,terms});
  if(!decision.allowed)
    throw new AppError(403,"WEB_ISSUANCE_UNAVAILABLE","Este código não está habilitado para emissão de Player Web por esta revenda.");
  // Provider credential check is outside DB transactions. The code itself has no Xtream password.
  const prepared=await preparePartnerActivation({code,username,password,web:true});
  if(prepared.pc.id!==source.id || prepared.partner.id!==owner.id)
    throw new AppError(409,"SOURCE_CHANGED","O código mudou durante a verificação; tente novamente.");
  const {wa,device,reused}=await createRecord({partner:issuer,actor,label,contentOwnerPartnerId:owner.id,sourcePartnerCodeId:source.id,issuanceKey:requestKey});
  if(reused){
    if(wa.status==="pending"){
      const committed=await liveActivationOf(wa.deviceId);
      if(committed){ await wa.update({status:"active"});return getWebAccess(wa.id,{partnerId:issuer.id}); }
      throw new AppError(409,"ISSUANCE_PENDING","Emissão em andamento. Consulte novamente.");
    }
    return getWebAccess(wa.id,{partnerId:issuer.id});
  }
  try {
    const result=await activatePrepared({prepared,mac:device.mac,installationId:device.lastInstallationId,
      idempotencyKey:requestKey,webIssuerPartnerId:issuer.id,meta:{ip:actor?.ip,userAgent:"delta-web-issuance"}});
    await result.activation.update({deliveryModes:{...(await defaultModes())}});
    await wa.update({status:"active"});
    await audit({actor,action:"web_access.issue_by_code",entityType:"web_access",entityId:wa.id,
      metadata:{issuerPartnerId:issuer.id,contentOwnerPartnerId:owner.id,partnerCodeId:source.id,
        activationId:result.activation.id,commercialOrigin:decision.funding}});
    return getWebAccess(wa.id,{partnerId:issuer.id});
  }catch(err){
    // If the database transaction failed, remove uncharged pending records.
    // If it committed before a later error, preserve the record to avoid charging twice.
    const committed=await liveActivationOf(device.id).catch(()=>null);
    if(!committed){
      await wa.destroy().catch(()=>{});
      await device.destroy().catch(()=>{});
    }
    throw err;
  }
}

/** Explicit, audited credential reveal for the verified CONTENT OWNER only. */
export async function revealWebSourceCredentials(id,{ownerPartnerId,actor}){
  const wa=await loadOwned(id,{contentOwnerPartnerId:ownerPartnerId});
  const activation=await liveActivationOf(wa.deviceId);
  if(!activation || activation.partnerId!==ownerPartnerId || !activation.credentialsEnc)
    throw notFound("Credenciais desta ativação");
  const {username,password}=JSON.parse(decryptSecret(activation.credentialsEnc));
  await audit({actor,action:"web_access.credentials.reveal",entityType:"web_access",entityId:wa.id,
    metadata:{contentOwnerPartnerId:ownerPartnerId}});
  return {username,password,mac:wa.Device?.mac};
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
    if (scope.contentOwnerPartnerId) where[Op.and]=[{[Op.or]:[{contentOwnerPartnerId:scope.contentOwnerPartnerId},{partnerId:scope.contentOwnerPartnerId,contentOwnerPartnerId:null}]}];
    const wa = await WebAccess.findOne({ where, transaction: t, lock: t.LOCK.UPDATE });
    if (!wa) throw notFound("Acesso web");
    if (!rule.from.includes(wa.status)) throw new AppError(409, "INVALID_STATE", `Não é possível executar '${action}' em um acesso '${wa.status}'.`);
    const a = await liveActivationOf(wa.deviceId, t);

    if (action === "unblock" && role !== "admin" && a?.blockedBy &&
      a.blockedBy !== (role === "content_partner" ? "content_partner" : "partner")) {
      throw new AppError(403, "BLOCKED_BY_PLATFORM", "Este bloqueio foi aplicado por outro nível de administração.");
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

/**
 * Recuperação segura de um código revogado. A validação externa acontece antes de
 * reservar o código; a transação comercial verifica a reserva imediatamente antes
 * de cobrar, impedindo que uma tentativa antiga prossiga após perder o lease.
 *
 * A recuperação é reexecutável: se a ativação já foi gravada, conclui apenas os
 * metadados; nunca repete a venda. O token da tentativa fica persistido em
 * statusReason, e a idempotência da ativação usa o mesmo identificador.
 */
const RESTORE_PREFIX = "web-restore:";
const RESTORE_LEASE_MS = 30 * 60 * 1000;
const restoreIdempotency = (reason) => `web-restore-${reason.slice(RESTORE_PREFIX.length)}`;
const restoredActivationFor = async (wa) => {
  if (!wa.statusReason?.startsWith(RESTORE_PREFIX)) return null;
  const device = await Device.findByPk(wa.deviceId);
  if (!device) throw notFound("Dispositivo web");
  return Activation.findOne({ where: {
    deviceId: wa.deviceId,
    idempotencyKey: `${device.mac}:${restoreIdempotency(wa.statusReason)}`,
    status: "active",
  } });
};

async function finalizeWebRestore(id, claim, activationId, actor, reason, resumed = false) {
  const completed = await sequelize.transaction(async (t) => {
    const wa = await WebAccess.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!wa || wa.status !== "pending" || wa.statusReason !== claim)
      throw new AppError(409, "RESTORE_CLAIM_LOST", "A recuperação foi substituída por outra operação; atualize a página.");
    const activation = await Activation.findByPk(activationId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!activation || activation.deviceId !== wa.deviceId || activation.status !== "active" ||
        !activation.providerId || !activation.partnerId || !activation.partnerCodeId || !activation.credentialsEnc)
      throw new AppError(409, "RESTORE_NOT_CONFIGURED", "A nova ativação ainda não está pronta para uso.");
    const code = await PartnerCode.findByPk(activation.partnerCodeId, { transaction: t });
    if (!code || code.partnerId !== activation.partnerId)
      throw new AppError(409, "RESTORE_INVALID_SOURCE", "A ativação não pertence ao código selecionado.");
    // Titular do conteúdo é quem responde pelas credenciais; o emissor/revendedor
    // permanece em partnerId. Ambos os vínculos são alterados junto ao estado.
    await wa.update({ status: "active", statusReason: null,
      contentOwnerPartnerId: activation.partnerId, sourcePartnerCodeId: activation.partnerCodeId }, { transaction: t });
    await audit({ actor, action: "web_access.restore", entityType: "web_access", entityId: id,
      metadata: { activationId: activation.id, reason, resumed, contentOwnerPartnerId: activation.partnerId,
        sourcePartnerCodeId: activation.partnerCodeId }, transaction: t });
    return activation.id;
  });
  dropMirrorAuth(completed);
  return getWebAccess(id);
}

async function reserveWebRestore(id) {
  const claim = `${RESTORE_PREFIX}${randomUUID()}`;
  const [reserved] = await WebAccess.update({ status: "pending", statusReason: claim },
    { where: { id, status: "revoked" } });
  if (reserved) return { claim };
  const prior = await WebAccess.findByPk(id);
  if (!prior) throw notFound("Acesso web");
  if (prior.status !== "pending" || !prior.statusReason?.startsWith(RESTORE_PREFIX))
    throw new AppError(409, "NOT_REVOKED", "Este acesso não está revogado.");

  // Caiu após gravar a ativação, antes de liberar o código? Finalize sem cobrança.
  const committed = await restoredActivationFor(prior);
  if (committed) return { recovered: prior, activationId: committed.id };

  // Uma tentativa ativa não pode ser roubada. Após 30 minutos ela pode ser
  // retomada; a transação de ativação confere o token antes de cobrar.
  if (new Date(prior.updatedAt).getTime() > Date.now() - RESTORE_LEASE_MS)
    throw new AppError(409, "RESTORE_IN_PROGRESS", "Recuperação em andamento. Tente novamente mais tarde.");
  const cutoff = new Date(Date.now() - RESTORE_LEASE_MS);
  // Bloqueie ANTES de inspecionar a ativação: uma venda pode ter sido
  // confirmada enquanto aguardávamos a trava da tentativa anterior.
  return sequelize.transaction(async (t) => {
    const locked = await WebAccess.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!locked || locked.status !== "pending" || !locked.statusReason?.startsWith(RESTORE_PREFIX))
      throw new AppError(409, "RESTORE_CONFLICT", "O acesso mudou; consulte novamente.");
    const device = await Device.findByPk(locked.deviceId, { transaction: t });
    if (!device) throw notFound("Dispositivo web");
    const committed = await Activation.findOne({ where: {
      deviceId: locked.deviceId,
      idempotencyKey: `${device.mac}:${restoreIdempotency(locked.statusReason)}`,
      status: "active",
    }, transaction: t });
    if (committed) return { recovered: locked, activationId: committed.id };
    if (new Date(locked.updatedAt).getTime() > cutoff.getTime())
      throw new AppError(409, "RESTORE_IN_PROGRESS", "Recuperação em andamento. Tente novamente mais tarde.");
    const previousAttempt = locked.statusReason;
    await locked.update({ status: "pending", statusReason: claim }, { transaction: t });
    await audit({ actor: { type: "system", id: null }, action: "web_access.restore_reclaim",
      entityType: "web_access", entityId: id,
      metadata: { reason: "lease_expired_no_activation", previousAttempt }, transaction: t });
    return { claim };
  });
}

export async function restoreRevokedWebAccess(id, { config, reason }, actor) {
  if (config?.mode !== "partner")
    throw new AppError(422, "PARTNER_RESTORE_ONLY", "Esta recuperação exige código e novas credenciais de parceria.");
  // Verificação de credenciais antes de alterar o status ou reservar o código.
  const wa = await WebAccess.findByPk(id, { include: [{ model: Device, attributes: ["mac", "lastInstallationId"] }] });
  if (!wa) throw notFound("Acesso web");
  if (wa.status !== "revoked" && wa.status !== "pending")
    throw new AppError(409, "NOT_REVOKED", "Este acesso não está revogado.");
  if (!wa.Device?.mac) throw notFound("Dispositivo web");
  // Retomada de uma operação já cobrada não depende mais de consultar o Xtream.
  if (wa.status === "pending" && wa.statusReason?.startsWith(RESTORE_PREFIX)) {
    const committed = await restoredActivationFor(wa);
    if (committed) return finalizeWebRestore(id, wa.statusReason, committed.id, actor, reason, true);
  }
  const prepared = await preparePartnerActivation({ ...config, web: true });
  const { claim, recovered, activationId } = await reserveWebRestore(id);
  if (recovered) return finalizeWebRestore(id, recovered.statusReason, activationId, actor, reason, true);

  try {
    // A própria transação comercial bloqueia WebAccess e verifica esta claim;
    // um trabalhador atrasado não debita créditos após o lease ser retomado.
    const result = await activatePrepared({ prepared, mac: wa.Device.mac,
      installationId: wa.Device.lastInstallationId, idempotencyKey: restoreIdempotency(claim),
      restoreClaim: { id, claim }, meta: { ip: actor?.ip, userAgent: "admin-web-restore" } });
    return await finalizeWebRestore(id, claim, result.activation.id, actor, reason);
  } catch (err) {
    const current = await WebAccess.findByPk(id).catch(() => null);
    if (current?.status === "pending" && current.statusReason === claim) {
      // Se a transação de ativação comitou, NUNCA descartar a reserva nem repetir
      // a cobrança. A próxima chamada somente finaliza o vínculo.
      const committed = await restoredActivationFor(current).catch(() => null);
      if (!committed) await WebAccess.update({ status: "revoked", statusReason: "Recuperação falhou; tente novamente" },
        { where: { id, status: "pending", statusReason: claim } }).catch(() => {});
    }
    throw err;
  }
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
    const patch = {};
    if (deliveryModes !== undefined) patch.deliveryModes = deliveryModes === null ? { ...(await defaultModes()) } : { ...(await defaultModes()), ...sanitizeModes(deliveryModes) };
    await activation.update(patch);
    dropMirrorAuth(activation.id);
    Object.assign(changes, patch);
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
  if (!wa || wa.status === "revoked" || wa.status === "pending") {
    await audit({ actor: { type: "anonymous", ip }, action: "web_access.login", entityType: "web_access", entityId: wa?.id ?? null, result: "denied", metadata: { reason: wa ? wa.status : "unknown" } });
    throw invalidCode();
  }
  const outcome = await sequelize.transaction(async (t) => {
    const activation = await Activation.findOne({
      where: { deviceId: wa.deviceId, status: { [Op.ne]: "revoked" },
        [Op.or]: [{ providerId: { [Op.ne]: null } }, { playlistUrlEnc: { [Op.ne]: null } }] },
      order: [["activatedAt", "DESC"]], transaction: t, lock: t.LOCK.UPDATE,
    });
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
    kind: (activation.licenseId || activation.grantedLicenseId) ? "license" : "partner",
    status: "active",
    configurationStatus: stateOf(activation),
    expiresAt: decision.expiresAt,
    listName: activation.playlistName ?? null,
    tokens: { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresIn: session.expiresIn },
  };
}

export { MODE_KINDS, WEB_CODE_RE };

export async function playerWebDefaults() { return (await getPlatformSettings()).web; }
