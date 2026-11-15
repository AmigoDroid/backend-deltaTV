/**
 * Cobertura financeira obrigatória para emissão por Master.
 * O saldo de créditos só nasce de Pix confirmado, transações da rede ou ajustes
 * expressamente autorizados pelo Superadmin. Debitar e emitir na MESMA transação.
 * Preços são escolhidos exclusivamente no backend; nunca pelo navegador.
 */
import { AppError } from "../../shared/errors.js";
import { pricesFor } from "../credits/credit.service.js";
import { creditMove } from "../credits/credit-ledger.js";
import { totalPrepaidCredits } from "./prepaid-issuance.policy.js";


export async function debitPrepaidIssuance(transaction, { partnerId, months, quantity, idempotencyKey, actor, channel }) {
  const offer = (await pricesFor(partnerId, transaction)).find(p => p.months === months);
  if (!offer) throw new AppError(422, "PREPAID_ISSUANCE_PRICE_REQUIRED",
    "Não existe preço de licença em créditos para este plano. Configure o preço no Superadmin antes de emitir.");
  const unitPriceCredits = Number(offer.priceCredits);
  const totalCredits = totalPrepaidCredits(unitPriceCredits, quantity);
  if (totalCredits === null) throw new AppError(422, "INVALID_PREPAID_AMOUNT", "Preço ou quantidade inválida para emissão.");
  const creditBalanceAfter = await creditMove(transaction, {
    partnerId, delta: -totalCredits, kind: "purchase", months, quantity, unitPriceCredits, actor,
    note: `Emissão pré-paga (${channel}) · referência ${idempotencyKey}`,
  });
  return { unitPriceCredits, totalCredits, creditBalanceAfter };
}
