import { QueryTypes } from "sequelize";
import { sequelize, Device, Partner } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { normalizeMac } from "../../shared/mac.js";
import { audit } from "../../shared/audit.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { applyOnce } from "./stock.service.js";
import { isPrimaryMaster, maySelfIssue } from "../distribution/master-issuance.policy.js";
import { debitPrepaidIssuance } from "../distribution/prepaid-issuance.service.js";

/**
 * Emissão e aplicação direta SEM criar unidades intermediárias no estoque.
 * Toda autorização é revalidada no banco, durante a mesma transação da ativação.
 * O idempotencyKey é obrigatório para impedir renovação duplicada em timeout/retry.
 */
export async function activateDirect({ issuerType, issuerId, partnerId = null, actor, mac: macInput, months, idempotencyKey }) {
  const mac = normalizeMac(macInput);
  if (!mac) throw new AppError(422, "INVALID_MAC", "Informe um MAC válido.");
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new AppError(422, "INVALID_MONTHS", "Duração inválida.");
  if (issuerType === "admin" && actor?.role !== "superadmin")
    throw new AppError(403, "SUPERADMIN_ONLY", "Somente o Superadmin pode emitir diretamente sem estoque.");
  if (issuerType !== "admin" && issuerType !== "master")
    throw new AppError(403, "ISSUER_NOT_ALLOWED", "Emissão não autorizada.");
  const issuer = issuerType === "admin" ? actor.id : partnerId;
  if (!issuer) throw new AppError(403, "INVALID_ISSUER", "Emissor não identificado.");

  const result = await sequelize.transaction(async transaction => {
    let partner = null;
    if (issuerType === "master") {
      // Trava o cadastro: a revogação ou mudança de hierarquia não pode ocorrer no meio da emissão.
      partner = await Partner.findByPk(partnerId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!isPrimaryMaster(partner)) throw new AppError(403, "ONLY_PRIMARY_MASTER", "Somente Master principal pode emitir diretamente.");
      const [permitted] = await sequelize.query(`SELECT enabled FROM reseller_master_issuance_permissions
        WHERE partner_id = :id`, { replacements: { id: partnerId }, transaction, type: QueryTypes.SELECT });
      if (!maySelfIssue(partner, permitted?.enabled === true))
        throw new AppError(403, "SELF_ISSUE_NOT_ALLOWED", "Este Master não está autorizado pelo Superadmin.");
    }

    // INSERT ON CONFLICT espera o fim de uma solicitação concorrente com a mesma chave.
    await sequelize.query(`INSERT INTO license_direct_device_requests
      (issuer_type,issuer_id,idempotency_key,mac,months)
      VALUES(:issuerType,:issuer,:key,:mac,:months)
      ON CONFLICT (issuer_type,issuer_id,idempotency_key) DO NOTHING`, {
      replacements: { issuerType, issuer, key: idempotencyKey, mac, months }, transaction, type: QueryTypes.RAW,
    });
    const [request] = await sequelize.query(`SELECT mac,months,result FROM license_direct_device_requests
      WHERE issuer_type = :issuerType AND issuer_id = :issuer AND idempotency_key = :key FOR UPDATE`, {
      replacements: { issuerType, issuer, key: idempotencyKey }, transaction, type: QueryTypes.SELECT,
    });
    if (!request || request.mac !== mac || Number(request.months) !== months)
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Esta operação já foi enviada com outros dados.");
    if (request.result) return { ...request.result, alreadyProcessed: true };

    const device = await Device.findOne({ where: { mac }, transaction, lock: transaction.LOCK.UPDATE });
    if (!device) throw new AppError(404, "DEVICE_NOT_FOUND", "TV não encontrada. Abra o DeltaTV na TV para registrar o MAC primeiro.");
    // A aplicação direta de Master também precisa ser paga. A cobrança só
    // ocorre após checar uma requisição já concluída e é revertida se a ativação falhar.
    const charged = issuerType === "master"
      ? await debitPrepaidIssuance(transaction, { partnerId, months, quantity:1,
          idempotencyKey, actor, channel:"direct-device" })
      : null;
    const applied = await applyOnce({ partner, actor, device, months, consumeStock: false,
      adminOverride: issuerType === "admin", transaction });
    const response = { ...applied, mac, issuance: "direct", alreadyProcessed: false,
      ...(charged ? charged : {adminException:true}) };
    await sequelize.query(`UPDATE license_direct_device_requests SET result = CAST(:result AS jsonb)
      WHERE issuer_type = :issuerType AND issuer_id = :issuer AND idempotency_key = :key`, {
      replacements: { result: JSON.stringify(response), issuerType, issuer, key: idempotencyKey }, transaction, type: QueryTypes.RAW,
    });
    await audit({ actor, action: `license.direct_issued_by_${issuerType}`, entityType: "device", entityId: device.id,
      metadata: { mac, months, licenseId: applied.licenseId, activationId: applied.activationId,
        idempotencyKey, ...(charged || {exception:"superadmin_direct_issuance",financialReceiptVerified:false}) }, transaction });
    return response;
  });
  clearMirrorAuth();
  return result;
}
