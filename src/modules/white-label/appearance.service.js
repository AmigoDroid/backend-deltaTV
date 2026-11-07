import { sequelize, WhiteLabelApp, WhiteLabelAppAppearance } from '../../db/models/index.js';
import { AppError, notFound } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { appearanceBody } from './appearance.schema.js';
import { defaultAppearance } from './appearance.presets.js';
import { normalizeAppearanceScreens } from './appearance.screens.js';
const publishedCache = new Map(); // 30-second bounded cache; never stores drafts
const CACHE_MS = 30_000;

async function readApp(appId, partnerId, transaction, lock = false) {
  const app = await WhiteLabelApp.findOne({
    where: { id: appId, ...(partnerId ? { partnerId } : {}) }, transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!app) throw notFound('Aplicativo');
  return app;
}
function ensureEnabled(app, partnerId) {
  // Only Superadmin can grant access; partners must not bypass the feature toggle.
  if (partnerId && !app.appearanceEnabled)
    throw new AppError(403, 'APPEARANCE_DISABLED', 'O Estúdio Visual não foi habilitado para este aplicativo.');
}
function initial(app) { return defaultAppearance(app.name, app.logoUrl); }
export async function listEditableAppearances(partnerId) {
  if (!partnerId) return [];
  const rows = await WhiteLabelApp.findAll({
    where: { partnerId, appearanceEnabled: true },
    attributes: ['id', 'name', 'appKey'], order: [['name', 'ASC']],
  });
  return rows.map(app => ({ id: app.id, name: app.name, appKey: app.appKey }));
}
export async function getAppearance(appId, partnerId = null) {
  const app = await readApp(appId, partnerId);
  ensureEnabled(app, partnerId);
  const record = await WhiteLabelAppAppearance.findOne({ where: { appId } });
  return {
    appId, appKey: app.appKey, appName: app.name, enabled: !!app.appearanceEnabled,
    draft: record?.draftConfig || initial(app),
    published: record?.publishedConfig || null, version: record?.publishedVersion || 0,
    publishedAt: record?.publishedAt || null,
  };
}
export async function setAppearanceAccess(appId, enabled, actor) {
  return sequelize.transaction(async transaction => {
    const app = await readApp(appId, null, transaction, true);
    if (app.appearanceEnabled !== enabled) {
      await app.update({ appearanceEnabled: enabled }, { transaction });
      await audit({ actor, action: enabled ? 'white-label.appearance.enable' : 'white-label.appearance.disable',
        entityType: 'white_label_app', entityId: appId, metadata: { enabled }, transaction });
    }
    publishedCache.delete(app.appKey);
    return { appId, enabled: !!app.appearanceEnabled };
  });
}
export async function saveAppearance(appId, partnerId, rawConfig, actor) {
  const config = appearanceBody.parse(normalizeAppearanceScreens(rawConfig));
  return sequelize.transaction(async transaction => {
    const app = await readApp(appId, partnerId, transaction, true);
    ensureEnabled(app, partnerId);
    const [record] = await WhiteLabelAppAppearance.findOrCreate({ where: { appId },
      defaults: { appId, draftConfig: initial(app) }, transaction });
    await record.update({ draftConfig: config, editedBy: actor?.userId || actor?.id || null }, { transaction });
    await audit({ actor, action: 'white-label.appearance.draft', entityType: 'white_label_app',
      entityId: appId, metadata: { template: config.template }, transaction });
    return { appId, draft: config, version: record.publishedVersion };
  });
}
export async function publishAppearance(appId, partnerId, actor) {
  return sequelize.transaction(async transaction => {
    const app = await readApp(appId, partnerId, transaction, true);
    ensureEnabled(app, partnerId);
    const [record] = await WhiteLabelAppAppearance.findOrCreate({ where: { appId },
      defaults: { appId, draftConfig: initial(app) }, transaction });
    const published = appearanceBody.parse(normalizeAppearanceScreens(record.draftConfig || initial(app)));
    const version = record.publishedVersion + 1;
    await record.update({ publishedConfig: published, publishedVersion: version, publishedAt: new Date(),
      editedBy: actor?.userId || actor?.id || null }, { transaction });
    await audit({ actor, action: 'white-label.appearance.publish', entityType: 'white_label_app',
      entityId: appId, metadata: { template: published.template, version }, transaction });
    publishedCache.delete(app.appKey);
    return { appId, version, publishedAt: record.publishedAt };
  });
}
export async function publicAppearance(appKey) {
  const cached = publishedCache.get(appKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  const app = await WhiteLabelApp.findOne({ where: { appKey },
    attributes: ['id', 'appKey', 'status', 'appearanceEnabled'] });
  if (!app || !app.appearanceEnabled || app.status === 'archived') throw notFound('Aparência publicada');
  const record = await WhiteLabelAppAppearance.findOne({ where: { appId: app.id } });
  if (!record?.publishedConfig || record.publishedVersion < 1) throw notFound('Aparência publicada');
  const data = { schema: 1, appKey, version: record.publishedVersion, config: record.publishedConfig };
  if (publishedCache.size > 2000) publishedCache.clear();
  publishedCache.set(appKey, { data, expiresAt: Date.now() + CACHE_MS });
  return data;
}
