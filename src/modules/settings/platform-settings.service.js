import { PlatformSetting } from "../../db/models/index.js";
import { audit } from "../../shared/audit.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { clearResolutionCache } from "../provider-monitor/resolve.service.js";
export const DEFAULT_SETTINGS = { trial: { enabled: true, days: 7 }, web: { autoHttps: true, deliveryModes: { api: "redirect", live: "proxy", movie: "redirect", series: "redirect" } } };
let cached = null, until = 0, generation = 0;
const copy = value => structuredClone(value);
export const clearSettingsCache = () => { generation++; cached = null; until = 0; };
export async function getPlatformSettings(transaction) {
  if (!transaction && cached && Date.now() < until) return copy(cached);
  const current = generation;
  const row = await PlatformSetting.findByPk("defaults", { transaction });
  const value = row?.value || DEFAULT_SETTINGS;
  if (!transaction && current === generation) { cached = copy(value); until = Date.now() + 5000; }
  return copy(value);
}
export async function savePlatformSettings(value, actor) {
  await PlatformSetting.sequelize.transaction(async transaction => {
    await PlatformSetting.upsert({ key: "defaults", value }, { transaction });
    await audit({ actor, action: "platform.defaults.update", entityType: "platform_settings", entityId: "defaults", metadata: value, transaction });
  });
  clearSettingsCache(); clearMirrorAuth(); clearResolutionCache();
  return copy(value);
}
export async function webActivationDefaults(activation) {
  if (!(activation?.Device?.platform === "web" || /^webtv-/i.test(activation?.installationId || ""))) return activation;
  const { web } = await getPlatformSettings();
  return { ...(activation.toJSON ? activation.toJSON() : activation), webAutoHttps: web.autoHttps };
}

export async function savePlatformSection(section, value, actor) {
  const result = await PlatformSetting.sequelize.transaction(async transaction => {
    const row = await PlatformSetting.findByPk("defaults", { transaction, lock: transaction.LOCK.UPDATE });
    const current = copy(row?.value || DEFAULT_SETTINGS);
    current[section] = value;
    await PlatformSetting.upsert({ key: "defaults", value: current }, { transaction });
    await audit({ actor, action: `platform.${section}.defaults.update`, entityType: "platform_settings", entityId: section, metadata: value, transaction });
    return current;
  });
  clearSettingsCache(); clearMirrorAuth(); clearResolutionCache();
  return copy(result);
}
