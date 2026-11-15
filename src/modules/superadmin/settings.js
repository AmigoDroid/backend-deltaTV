import { AppError } from "../../shared/errors.js";
import { PlatformSetting, sequelize } from "../../db/models/index.js";
import { encryptSecret, decryptSecret } from "../../shared/crypto.js";
import { audit } from "../../shared/audit.js";
const KEY = "superadmin.controls";
const defaults = {
  maintenance: false,
  maintenanceMessage: "Estamos em manutenção. Tente novamente em breve.",
  brand: { name: "DeltaTV", logoUrl: "", primaryColor: "#7768f6" },
  terms: "",
  integrations: [],
};
let cached = null,
  until = 0;
export async function readControls() {
  if (cached && Date.now() < until) return cached;
  const row = await PlatformSetting.findByPk(KEY);
  cached = { ...defaults, ...row?.value };
  until = Date.now() + 2000;
  return cached;
}
export async function publicControls() {
  const c = await readControls();
  return {
    maintenance: c.maintenance,
    maintenanceMessage: c.maintenanceMessage,
    brand: c.brand,
    terms: c.terms,
  };
}
export async function saveControls(input, actor) {
  const result = await sequelize.transaction(async (transaction) => {
    await PlatformSetting.findOrCreate({
      where: { key: KEY },
      defaults: { value: defaults },
      transaction,
    });
    const row = await PlatformSetting.findByPk(KEY, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const before = row.value;
    const { reason, ...fields } = input;
    fields.integrations = fields.integrations.map((x) => {
      const secret =
        x.secret ||
        (before.integrations?.find((y) => y.name === x.name)?.secretEnc
          ? decryptSecret(
              before.integrations.find((y) => y.name === x.name).secretEnc,
            )
          : "");
      if (x.name === "mercadopago" && x.enabled) {
        let parsed;
        try {
          parsed = JSON.parse(secret);
        } catch {
          throw new AppError(
            422,
            "INVALID_INTEGRATION",
            "Mercado Pago exige JSON com accessToken e webhookSecret.",
          );
        }
        if (
          !parsed ||
          typeof parsed.accessToken !== "string" ||
          parsed.accessToken.length < 10 ||
          typeof parsed.webhookSecret !== "string" ||
          parsed.webhookSecret.length < 16 ||
          Object.keys(parsed).some(
            (k) => !["accessToken", "webhookSecret"].includes(k),
          )
        )
          throw new AppError(
            422,
            "INVALID_INTEGRATION",
            "Mercado Pago exige accessToken e webhookSecret válidos.",
          );
      }
      return {
        name: x.name,
        enabled: x.enabled,
        secretEnc: secret ? encryptSecret(secret) : null,
      };
    });
    await row.update({ value: fields }, { transaction });
    await audit({
      actor,
      action: "settings.global.update",
      entityType: "platform_setting",
      entityId: KEY,
      metadata: { reason, before, after: fields },
      transaction,
    });
    return fields;
  });
  cached = null;
  until = 0;
  return presentControls(result);
}
export function presentControls(c) {
  return {
    ...c,
    integrations: c.integrations.map(({ name, enabled, secretEnc }) => ({
      name,
      enabled,
      configured: !!secretEnc,
    })),
  };
}
export async function maintenanceGate(req, _res, next) {
  try {
    if (
      !/^\/api\/v1\/(client\/(activate|claim)|partner|content-partner)/.test(
        req.path,
      ) ||
      ["GET", "HEAD", "OPTIONS"].includes(req.method)
    )
      return next();
    const c = await readControls();
    if (c.maintenance) {
      const { AppError } = await import("../../shared/errors.js");
      return next(new AppError(503, "MAINTENANCE", c.maintenanceMessage));
    }
    next();
  } catch (error) {
    next(error);
  }
}
