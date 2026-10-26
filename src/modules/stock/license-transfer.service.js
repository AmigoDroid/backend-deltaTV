import { Op } from "sequelize";
import { sequelize, Activation, License, LicenseEvent } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { revokeSessionsOf } from "../access/access.service.js";
import { dropMirrorAuth } from "../mirror/mirror.cache.js";
import { isLiveLicense } from "./stock-license.js";

const live = { [Op.ne]: "revoked" };
const DAY = 86_400_000;

/**
 * Passa a licença que um revendedor vendeu (concedida pelo código dele) de um MAC para outro, SEM mexer no prazo.
 *
 * O tempo começou a contar na venda e segue contando: a licença mantém o mesmo vencimento, então o cliente só leva
 * o que ainda resta. Na mesma transação:
 *   1. a ativação do MAC de origem é revogada (sessões derrubadas, credenciais apagadas);
 *   2. o MAC de destino ganha uma ativação com o MESMO servidor e as MESMAS credenciais do cliente;
 *   3. a licença passa a apontar para a nova ativação (índice único garante uma ativação viva por licença).
 *
 * Quem pode: só o revendedor DONO da licença (ownerPartnerId = ele) e da ativação (partnerId = ele). O destino é
 * resolvido pelo chamador (mesma política de edição por MAC das demais ações do painel).
 */
export async function transferGrantedLicense({ partner, actor, activationId, toDevice }) {
  const result = await sequelize.transaction(async (t) => {
    const lock = { transaction: t, lock: t.LOCK.UPDATE };
    const now = new Date();

    const src = await Activation.findOne({
      where: { id: activationId, partnerId: partner.id, status: live, grantedLicenseId: { [Op.ne]: null } }, ...lock,
    });
    if (!src) throw notFound("Licença deste dispositivo");
    if (src.deviceId === toDevice.id) throw new AppError(422, "SAME_DEVICE", "O MAC de destino é o mesmo do dispositivo atual.");

    const license = await License.findByPk(src.grantedLicenseId, lock);
    if (!license || license.ownerPartnerId !== partner.id) throw notFound("Licença deste dispositivo");
    if (!isLiveLicense(license, now)) {
      if (license.status === "active") {
        throw new AppError(409, "LICENSE_EXPIRED", "A licença deste dispositivo já venceu: não há tempo restante a transferir. Renove-a com uma licença do estoque.");
      }
      throw new AppError(409, "LICENSE_NOT_TRANSFERABLE", "Esta licença está bloqueada, suspensa ou cancelada. Fale com a plataforma.");
    }

    const clash = await Activation.findOne({ where: { deviceId: toDevice.id, partnerId: partner.id, status: live }, ...lock });
    if (clash) {
      throw new AppError(409, "TARGET_ALREADY_LINKED", "O MAC de destino já tem uma lista deste revendedor. Remova-a no MAC de destino antes de transferir.");
    }

    const { credentialsEnc, partnerCodeId, providerId } = src;
    const fromMac = src.mac;
    await src.update({
      status: "revoked", revokedAt: now, statusReason: `Licença transferida para ${toDevice.mac}`, credentialsEnc: null,
    }, { transaction: t });
    await revokeSessionsOf(src.id, t);

    const created = await Activation.create({
      deviceId: toDevice.id, mac: toDevice.mac, installationId: toDevice.lastInstallationId ?? null,
      partnerId: partner.id, partnerCodeId, providerId, credentialsEnc, grantedLicenseId: license.id,
    }, { transaction: t });

    const remainingDays = Math.max(0, Math.ceil((license.expiresAt.getTime() - now.getTime()) / DAY));
    await LicenseEvent.create({
      licenseId: license.id, partnerId: partner.id, event: "transferred", fromDeviceId: src.deviceId, toDeviceId: toDevice.id,
      actorType: actor?.type ?? "partner", actorId: actor?.id ?? null,
      metadata: { fromMac, toMac: toDevice.mac, expiresAt: license.expiresAt, remainingDays, fromActivationId: src.id, toActivationId: created.id },
    }, { transaction: t });

    // from/to: é o que o histórico por MAC (publicEvent) exibe.
    const meta = { licenseId: license.id, from: fromMac, to: toDevice.mac, fromMac, toMac: toDevice.mac, expiresAt: license.expiresAt, remainingDays };
    await audit({ actor, action: "license.transfer.out", entityType: "device", entityId: src.deviceId, metadata: meta, transaction: t });
    await audit({ actor, action: "license.transfer.in", entityType: "device", entityId: toDevice.id, metadata: meta, transaction: t });

    return { oldActivationId: src.id, activationId: created.id, licenseId: license.id, fromMac, toMac: toDevice.mac, expiresAt: license.expiresAt, remainingDays };
  });
  dropMirrorAuth(result.oldActivationId); // a TV antiga perde o acesso já (depois do commit)
  const { oldActivationId, ...out } = result; // eslint-disable-line no-unused-vars
  return out;
}
