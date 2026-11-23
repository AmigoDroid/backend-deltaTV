import { Op } from 'sequelize';
import { sequelize, ClientApp, Device, DevicePairingToken } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { normalizeMac } from '../../shared/mac.js';
import { sha256 } from '../../shared/crypto.js';
import { appBindingByIdentifier, unavailable } from './client-app.service.js';
import { preparePartnerActivation, activatePrepared, partnerCodeForBinding } from '../activations/activation.service.js';

const invalidQr = () => new AppError(404, 'INVALID_QR', 'Este QR expirou ou é inválido. Na TV, pressione CONECTAR para gerar outro.');

export async function publicAppMetadata(identifier, { mac, token } = {}) {
  const binding = await appBindingByIdentifier(identifier).catch(e => { if (e.code === 'APP_NOT_AVAILABLE') return null; throw e; });
  if (!binding) return { name: 'Aplicativo', logoUrl: null, theme: null, available: false };
  const result = { name: binding.app.name, logoUrl: binding.app.logoUrl || null, theme: binding.app.theme || null, available: true };
  if (mac !== undefined || token !== undefined) {
    if (!mac || !token) return { ...result, available: false };
    const pairing = await validPairing(binding.app.id, mac, token);
    if (!pairing) return { ...result, available: false };
  }
  return result;
}

async function validPairing(appId, mac, token, transaction) {
  const normalized = normalizeMac(mac);
  if (!normalized || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const pairing = await DevicePairingToken.findOne({
    where: { tokenHash: sha256(token), usedAt: null, registrationUsedAt: null, expiresAt: { [Op.gt]: new Date() } },
    include: [{ model: Device, required: true, where: { mac: normalized, clientAppId: appId } }],
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}),
  });
  return pairing;
}

export async function linkFromPublicQr(identifier, { mac, token, username, password }, meta) {
  const known = await ClientApp.findOne({ where: { identifier } });
  if (!known) throw invalidQr();
  const binding = await appBindingByIdentifier(identifier);
  const pairing = await validPairing(binding.app.id, mac, token);
  if (!pairing) throw invalidQr();

  // The provider probe can take seconds. Do not keep a row lock while making external requests.
  const code = await partnerCodeForBinding(binding);
  const prepared = await preparePartnerActivation({ code, username, password });
  if (String(prepared.partner.id) !== String(binding.partner.id)) throw unavailable();

  // Only one concurrent submit may claim this QR. A crashed attempt releases after two minutes.
  const claimed = await sequelize.transaction(async transaction => {
    const locked = await validPairing(binding.app.id, mac, token, transaction);
    if (!locked) throw invalidQr();
    if (locked.qrLinkInProgressAt && Date.now() - new Date(locked.qrLinkInProgressAt).getTime() < 120_000) throw invalidQr();
    const current = await Device.findByPk(locked.deviceId, { transaction });
    if (!current || String(current.clientAppId) !== String(binding.app.id)) throw invalidQr();
    await locked.update({ qrLinkInProgressAt: new Date() }, { transaction });
    return { pairingId: locked.id, installationId: current.lastInstallationId, mac: current.mac };
  });
  try {
    // App ownership is rechecked in activatePrepared under its own DB transaction.
    const currentBinding = await appBindingByIdentifier(identifier);
    if (currentBinding.link.partnerCodeId !== binding.link.partnerCodeId ||
      String(currentBinding.partner.id) !== String(binding.partner.id)) throw unavailable();
    // Re-check the app binding and the pairing state before handing an activation to the existing engine.
    const lockedForActivation = await validPairing(currentBinding.app.id, claimed.mac, token);
    if (!lockedForActivation || lockedForActivation.id !== claimed.pairingId) throw invalidQr();
    await activatePrepared({ prepared, mac: claimed.mac, installationId: claimed.installationId, meta });
    await sequelize.transaction(async transaction => {
      const row = await DevicePairingToken.findByPk(claimed.pairingId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!row || row.usedAt || !row.qrLinkInProgressAt) throw invalidQr();
      await row.update({ usedAt: new Date(), qrLinkInProgressAt: null }, { transaction });
      await audit({ actor: { type: 'device', id: row.deviceId }, action: 'client_app.qr.linked',
        entityType: 'device', entityId: row.deviceId,
        metadata: { appId: identifier, partnerId: currentBinding.partner.id }, transaction });
    });
    return { ok: true };
  } catch (error) {
    await DevicePairingToken.update({ qrLinkInProgressAt: null }, { where: { id: claimed.pairingId, usedAt: null } });
    throw error;
  }
}
