import { Device, DeviceTrial, License, Plan, Activation } from "../../db/models/index.js";
import { generateCode, hashCode } from "../../shared/crypto.js";
import { audit } from "../../shared/audit.js";
import { getPlatformSettings } from "../settings/platform-settings.service.js";

/** Uma concessão por MAC, inclusive após reinstalação ou exclusão do cadastro do aparelho. */
export async function grantNewDeviceTrial(device, created, { transaction, installationId = null, paid = false } = {}) {
  if (!created || !device.mac) return null;
  const run = async t => {
    // Serializa emissões para este aparelho. A chave do ledger é o MAC, sem FK de exclusão em cascata.
    await Device.findByPk(device.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (await DeviceTrial.findByPk(device.mac, { transaction: t })) return null;
    const { trial } = await getPlatformSettings(t);
    const [record, fresh] = await DeviceTrial.findOrCreate({ where: { mac: device.mac }, defaults: { status: paid ? "paid" : trial.enabled ? "granting" : "disabled" }, transaction: t });
    if (!fresh || paid || !trial.enabled) return null;
    const startsAt = new Date(), expiresAt = new Date(startsAt.getTime() + trial.days * 86400000);
    const plan = await Plan.findOne({ where: { code: "AUTO_TRIAL" }, transaction: t });
    if (!plan) throw new Error("Plano de teste automático ausente. Execute as migrations.");
    const code = generateCode("TRIAL");
    const license = await License.create({ planId: plan.id, codeHash: hashCode(code), codeLast4: code.slice(-4), isTrial: true,
      status: "active", startsAt, expiresAt, maxDevices: 1, notes: `Teste gratuito de ${trial.days} dias para ${device.mac}` }, { transaction: t });
    const activation = await Activation.create({ deviceId: device.id, mac: device.mac, installationId: installationId || device.lastInstallationId || null,
      licenseId: license.id, status: "active" }, { transaction: t });
    await record.update({ status: "granted", licenseId: license.id, startsAt, expiresAt }, { transaction: t });
    await audit({ actor: { type: "system" }, action: "device.trial.granted", entityType: "activation", entityId: activation.id,
      metadata: { mac: device.mac, days: trial.days, licenseId: license.id, expiresAt }, transaction: t });
    return { license, activation };
  };
  return transaction ? run(transaction) : Device.sequelize.transaction(run);
}
