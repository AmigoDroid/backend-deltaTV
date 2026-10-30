import { QueryTypes } from "sequelize";
import { sequelize, CreditLedger } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";

/**
 * Núcleo da carteira de créditos: saldo por parceiro + extrato imutável.
 * Crédito é só um saldo pré-pago para comprar licença. Sem transferência entre parceiros, sem saque, sem venda de volta.
 * Fica separado de credit.service.js para o Pix (pix.service.js) creditar sem depender do resto.
 */
export const CREDIT_KINDS = ["topup", "purchase", "adjust"];

const sql = (text, replacements, transaction, type = QueryTypes.SELECT) =>
  sequelize.query(text, { replacements, transaction, type });

/**
 * Soma `delta` (créditos inteiros, + ou −) ao saldo e grava o extrato. Falta de saldo => 409 e a transação inteira desfaz.
 * Precisa de uma transação (`t`): o débito/crédito e o que ele paga têm que valer juntos ou não valer.
 */
export async function creditMove(t, { partnerId, delta, kind, rateCents = null, months = null, quantity = null, unitPriceCredits = null, chargeId = null, note = null, actor = null }) {
  if (!CREDIT_KINDS.includes(kind)) throw new Error(`tipo de lançamento inválido: ${kind}`);
  if (!Number.isSafeInteger(delta) || delta === 0) throw new AppError(422, "INVALID_AMOUNT", "Quantidade de créditos inválida.");
  await sql(
    `INSERT INTO credit_wallets (partner_id, balance) VALUES (:partnerId, 0) ON CONFLICT (partner_id) DO NOTHING`,
    { partnerId }, t, QueryTypes.RAW,
  );
  const rows = await sql(
    `UPDATE credit_wallets SET balance = balance + :delta, updated_at = now()
      WHERE partner_id = :partnerId AND balance + :delta >= 0
      RETURNING balance`,
    { partnerId, delta }, t,
  );
  if (rows.length === 0) throw new AppError(409, "INSUFFICIENT_CREDIT", "Saldo de créditos insuficiente.");
  const balanceAfter = Number(rows[0].balance);
  await CreditLedger.create({
    partnerId, kind, delta, balanceAfter, rateCents, months, quantity, unitPriceCredits, chargeId,
    note: note ?? null, actorUserId: actor?.id ?? null, actorName: actor?.name ?? null,
  }, { transaction: t });
  return balanceAfter;
}

/** Saldo atual (0 se a carteira ainda não existe). */
export async function creditBalanceOf(partnerId, transaction) {
  const rows = await sql(`SELECT balance FROM credit_wallets WHERE partner_id = :partnerId`, { partnerId }, transaction);
  return rows.length ? Number(rows[0].balance) : 0;
}
