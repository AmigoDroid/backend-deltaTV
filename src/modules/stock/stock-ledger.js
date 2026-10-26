import { QueryTypes } from "sequelize";
import { sequelize, LicenseStockLedger } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";

/**
 * Núcleo do estoque de licenças: saldo por (revendedor, duração) + extrato imutável.
 * Fica separado de stock.service.js para que a ativação por código (activation.service.js) consuma licença sem depender
 * dele (stock.service importa activation.service).
 */
export const STOCK_KINDS = ["reseller", "both"];

export const sql = (text, replacements, transaction, type = QueryTypes.SELECT) =>
  sequelize.query(text, { replacements, transaction, type });

/** Soma `delta` ao saldo (partner, months) e grava o extrato. Falta de saldo => 409 e a transação inteira desfaz. */
export async function move(t, { partnerId, months, delta, kind, actor, counterpartyPartnerId = null, transferId = null, deviceId = null, licenseId = null, unitPriceCents = null, note = null }) {
  await sql(
    `INSERT INTO license_stock (partner_id, months, quantity) VALUES (:partnerId, :months, 0) ON CONFLICT (partner_id, months) DO NOTHING`,
    { partnerId, months }, t, QueryTypes.RAW,
  );
  const rows = await sql(
    `UPDATE license_stock SET quantity = quantity + :delta, updated_at = now()
      WHERE partner_id = :partnerId AND months = :months AND quantity + :delta >= 0
      RETURNING quantity`,
    { partnerId, months, delta }, t,
  );
  if (rows.length === 0) {
    throw new AppError(409, "INSUFFICIENT_STOCK", `Estoque insuficiente de licenças de ${months} ${months === 1 ? "mês" : "meses"}.`);
  }
  const balanceAfter = Number(rows[0].quantity);
  await LicenseStockLedger.create({
    partnerId, months, delta, balanceAfter, kind, counterpartyPartnerId, transferId, deviceId, licenseId, unitPriceCents,
    note: note ?? null, actorUserId: actor?.id ?? null, actorName: actor?.name ?? null,
  }, { transaction: t });
  return balanceAfter;
}

export async function balancesOf(partnerId, transaction) {
  const rows = await sql(`SELECT months, quantity FROM license_stock WHERE partner_id = :partnerId AND quantity > 0 ORDER BY months`, { partnerId }, transaction);
  return rows.map((r) => ({ months: Number(r.months), quantity: Number(r.quantity) }));
}

/** Saldo atual de uma duração (0 se não houver). */
export async function quantityOf(partnerId, months, transaction) {
  const rows = await sql(`SELECT quantity FROM license_stock WHERE partner_id = :partnerId AND months = :months`, { partnerId, months }, transaction);
  return rows.length ? Number(rows[0].quantity) : 0;
}
