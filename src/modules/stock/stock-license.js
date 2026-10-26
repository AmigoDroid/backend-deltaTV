import { Op } from "sequelize";
import { License, Renewal, LicenseEvent } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { generateCode, hashCode } from "../../shared/crypto.js";
import { addMonthsUTC } from "../../shared/dates.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { move } from "./stock-ledger.js";

/**
 * Venda de UMA licença do estoque do revendedor a um cliente que acabou de ser ativado pelo código dele.
 * O tempo começa a contar AGORA (no momento da venda), não na primeira reprodução. Deve rodar dentro da transação
 * da ativação: se algo falhar depois, o estoque volta junto.
 *
 *  - `renew` ausente  -> cria a licença (dono = o revendedor, ativa, vence em `months` meses) e gasta 1 do estoque;
 *  - `renew` informado -> licença que já vencida deste cliente: o novo prazo conta a partir de agora.
 *
 * Sem saldo => AppError 409 INSUFFICIENT_STOCK (a transação do chamador desfaz).
 */
export async function sellFromStock(t, { partner, months, deviceId, activationId = null, renew = null, actor = null, note }) {
  const plan = await ensurePlan(months, { transaction: t });
  const now = new Date();
  let license;
  let expiresAt;
  if (renew) {
    const previous = renew.expiresAt;
    const base = renew.expiresAt && renew.expiresAt > now ? renew.expiresAt : now;
    expiresAt = addMonthsUTC(base, months);
    license = await renew.update({ planId: plan.id, expiresAt, startsAt: renew.startsAt ?? now, status: "active", statusReason: null }, { transaction: t });
    await Renewal.create({ licenseId: license.id, planId: plan.id, previousExpiresAt: previous, newExpiresAt: expiresAt, createdBy: actor?.id ?? null }, { transaction: t });
  } else {
    expiresAt = addMonthsUTC(now, months);
    const code = generateCode("LIC");
    license = await License.create({
      codeHash: hashCode(code), codeLast4: code.slice(-4), planId: plan.id, status: "active", startsAt: now, expiresAt,
      maxDevices: 1, ownerPartnerId: partner.id, assignedAt: now, createdBy: actor?.id ?? null,
      notes: `Estoque do revendedor ${partner.name}`,
    }, { transaction: t });
  }
  await move(t, { partnerId: partner.id, months, delta: -1, kind: "consume", actor, deviceId, licenseId: license.id, note });
  await LicenseEvent.create({
    licenseId: license.id, partnerId: partner.id, event: renew ? "assigned" : "activated", toDeviceId: deviceId,
    actorType: actor?.type ?? "device", actorId: actor?.id ?? null, metadata: { months, expiresAt, activationId, renewed: !!renew },
  }, { transaction: t });
  return { license, expiresAt };
}

/** Licença concedida ainda em uso (ativa e dentro do prazo)? Usada para impedir remoção que jogaria tempo pago fora. */
export const isLiveLicense = (license, now = new Date()) =>
  !!license && license.status === "active" && !!license.expiresAt && new Date(license.expiresAt) > now;

export const lockedByLicense = () =>
  new AppError(409, "LICENSE_ACTIVE", "Este dispositivo tem uma licença em andamento. Para trocar de aparelho, use Transferir para outro MAC; remover agora perderia o tempo restante.");
