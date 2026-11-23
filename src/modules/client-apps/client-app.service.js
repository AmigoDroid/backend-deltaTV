import { timingSafeEqual } from 'node:crypto';
import { Op } from 'sequelize';
import { sequelize, ClientApp, PartnerApp, Partner, PartnerCode, Device } from '../../db/models/index.js';
import { AppError, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { overdueSinceFor } from '../access/access.service.js';
import { evaluateAccess } from '../access/access.policy.js';
import { contentPortalAccessGuard } from '../partner-portal-sales/sales.service.js';
import { assertAppSlot, effectiveAppSlots } from './app-entitlement.js';

export const unavailable = () => new AppError(403, 'APP_NOT_AVAILABLE', 'Aplicativo indisponível. Fale com seu provedor.');
export const isLegacyAppId = value => !value || value === 'roku' || value === 'delta-tv-roku';
const validIdentifier = /^[a-z0-9][a-z0-9._-]{1,63}$/;

async function codeOfOwner(partnerId, partnerCodeId, transaction) {
  const code = await PartnerCode.findOne({ where: { id: partnerCodeId, partnerId, status: 'active', deletedAt: null }, transaction });
  if (!code || (code.expiresAt && new Date(code.expiresAt) <= new Date())) throw unavailable();
  return code;
}

export async function appBindingByIdentifier(identifier, { transaction } = {}) {
  if (isLegacyAppId(identifier)) return null;
  if (typeof identifier !== 'string' || !validIdentifier.test(identifier)) throw unavailable();
  const app = await ClientApp.findOne({ where: { identifier }, transaction });
  if (!app || app.status !== 'active') throw unavailable();
  const link = await PartnerApp.findOne({ where: { clientAppId: app.id, status: 'active' }, transaction });
  if (!link) throw unavailable();
  const partner = await Partner.findByPk(link.partnerId, { transaction });
  if (!partner || partner.status !== 'active' || (partner.startsAt && new Date(partner.startsAt) > new Date()) ||
      (partner.endsAt && new Date(partner.endsAt) <= new Date())) throw unavailable();
  const overdueSince = await overdueSinceFor(partner.id, transaction);
  if (!evaluateAccess({ activation: { status: 'active' }, partner, overdueSince }).allowed) throw unavailable();
  await codeOfOwner(partner.id, link.partnerCodeId, transaction);
  try { await contentPortalAccessGuard(partner.id); } catch (error) {
    if (error.code === 'PORTAL_ACCESS_EXPIRED') throw unavailable();
    throw error;
  }
  return { app, link, partner };
}

export async function bindingForDevice(device, opts = {}) {
  if (!device?.clientAppId) return null;
  const app = await ClientApp.findByPk(device.clientAppId, opts);
  if (!app || device.appId !== app.identifier) throw unavailable();
  return appBindingByIdentifier(app.identifier, opts);
}

export async function assertDeviceOwner(device, partnerId, opts = {}) {
  const binding = await bindingForDevice(device, opts);
  if (binding && String(binding.partner.id) !== String(partnerId)) throw unavailable();
  return binding;
}

export async function listPlatformApps() {
  const apps = await ClientApp.findAll({ order: [['createdAt', 'DESC']], include: [{ model: PartnerApp, include: [Partner] }] });
  return apps.map(a => {
    const data = a.toJSON();
    delete data.claimCodeHash;
    return data;
  });
}

export async function createPlatformApp(input, actor) {
  if (isLegacyAppId(input.identifier) || !validIdentifier.test(input.identifier)) throw new AppError(422, 'INVALID_APP_ID', 'Identificador reservado ou inválido.');
  return sequelize.transaction(async transaction => {
    const app = await ClientApp.create({ identifier: input.identifier, name: input.name, platform: 'roku', status: input.status, createdBy: actor.id }, { transaction });
    await audit({ actor, action: 'client_app.created', entityType: 'client_app', entityId: app.id, metadata: { identifier: input.identifier }, transaction });
    return { id: app.id, identifier: app.identifier, name: app.name, status: app.status };
  });
}

export async function editPlatformApp(id, input, actor) {
  return sequelize.transaction(async transaction => {
    const app = await ClientApp.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!app) throw notFound('Aplicativo');
    await app.update(input, { transaction });
    await audit({ actor, action: 'client_app.updated', entityType: 'client_app', entityId: id, metadata: input, transaction });
    return { id: app.id, identifier: app.identifier, name: app.name, status: app.status };
  });
}

export async function issueClaimCode(id, expiresMinutes, actor) {
  return sequelize.transaction(async transaction => {
    const app = await ClientApp.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!app) throw notFound('Aplicativo');
    if (await PartnerApp.count({ where: { clientAppId: app.id }, transaction })) throw new AppError(409, 'APP_ALREADY_CLAIMED', 'Aplicativo já vinculado.');
    const claimCode = randomToken(24);
    await app.update({ claimCodeHash: sha256(claimCode), claimCodeExpiresAt: new Date(Date.now() + expiresMinutes * 60_000) }, { transaction });
    await audit({ actor, action: 'client_app.claim_code.issued', entityType: 'client_app', entityId: app.id, metadata: { expiresMinutes }, transaction });
    return { claimCode, expiresAt: app.claimCodeExpiresAt };
  });
}

export async function claimPlatformApp({ identifier, claimCode, partnerCodeId }, partnerId, actor) {
  return sequelize.transaction(async transaction => {
    // Serializa TODA atribuição por parceiro, evitando duas requisições ocuparem a última vaga.
    await assertAppSlot(partnerId, transaction);
    const app = await ClientApp.findOne({ where: { identifier, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE });
    if (!app || !app.claimCodeHash || !app.claimCodeExpiresAt || app.claimCodeExpiresAt <= new Date()) throw unavailable();
    const supplied = Buffer.from(sha256(claimCode), 'hex');
    const actual = Buffer.from(app.claimCodeHash, 'hex');
    if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)) throw unavailable();
    if (await PartnerApp.count({ where: { clientAppId: app.id }, transaction })) throw new AppError(409, 'APP_ALREADY_CLAIMED', 'Aplicativo já vinculado.');
    await codeOfOwner(partnerId, partnerCodeId, transaction);
    const link = await PartnerApp.create({ clientAppId: app.id, partnerId, partnerCodeId }, { transaction });
    await app.update({ claimCodeHash: null, claimCodeExpiresAt: null }, { transaction });
    await audit({ actor, action: 'client_app.claimed', entityType: 'partner_app', entityId: link.id, metadata: { appId: app.identifier, partnerId, partnerCodeId }, transaction });
    return { id: link.id, identifier: app.identifier, name: app.name, status: link.status };
  });
}

export async function assignPlatformApp(appId, input, actor) {
  return sequelize.transaction(async transaction => {
    await assertAppSlot(input.partnerId, transaction);
    const app = await ClientApp.findByPk(appId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!app) throw notFound('Aplicativo');
    if (await PartnerApp.count({ where: { clientAppId: app.id }, transaction })) throw new AppError(409, 'APP_ALREADY_CLAIMED', 'Aplicativo já vinculado.');
    await codeOfOwner(input.partnerId, input.partnerCodeId, transaction);
    const link = await PartnerApp.create({ clientAppId: app.id, partnerId: input.partnerId, partnerCodeId: input.partnerCodeId }, { transaction });
    await app.update({ claimCodeHash: null, claimCodeExpiresAt: null }, { transaction });
    await audit({ actor, action: 'client_app.assigned', entityType: 'partner_app', entityId: link.id, metadata: { partnerId: input.partnerId, appId: app.identifier }, transaction });
    return { id: link.id };
  });
}

export async function unassignPlatformApp(appId, actor) {
  return sequelize.transaction(async transaction => {
    const link = await PartnerApp.findOne({ where: { clientAppId: appId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!link) throw notFound('Vínculo do aplicativo');
    const tvs = await Device.count({ where: { clientAppId: appId }, transaction });
    if (tvs) throw new AppError(409, 'APP_HAS_DEVICES', 'Este aplicativo possui TVs cadastradas. Remova os dispositivos antes de desvincular.');
    await link.destroy({ transaction });
    await audit({ actor, action: 'client_app.unassigned', entityType: 'partner_app', entityId: link.id, metadata: { appId }, transaction });
    return { ok: true };
  });
}

export async function listPartnerApps(partnerId) {
  const [links, slots] = await Promise.all([
    PartnerApp.findAll({ where: { partnerId }, include: [ClientApp, PartnerCode], order: [['createdAt', 'DESC']] }),
    effectiveAppSlots(partnerId),
  ]);
  const data = await Promise.all(links.map(async link => {
    const tvs = await Device.count({ where: { clientAppId: link.clientAppId } });
    const raw = link.toJSON();
    return { id: raw.id, identifier: raw.ClientApp?.identifier, name: raw.ClientApp?.name,
      appStatus: raw.ClientApp?.status, status: raw.status, partnerCodeId: raw.partnerCodeId,
      partnerCode: raw.PartnerCode?.code, tvs };
  }));
  return { data, slots };
}

export async function updatePartnerApp(id, partnerId, input, actor) {
  return sequelize.transaction(async transaction => {
    const link = await PartnerApp.findOne({ where: { id, partnerId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!link) throw notFound('Aplicativo');
    if (input.partnerCodeId) await codeOfOwner(partnerId, input.partnerCodeId, transaction);
    await link.update(input, { transaction });
    await audit({ actor, action: 'client_app.partner.updated', entityType: 'partner_app', entityId: id, metadata: input, transaction });
    return { id: link.id, status: link.status, partnerCodeId: link.partnerCodeId };
  });
}
