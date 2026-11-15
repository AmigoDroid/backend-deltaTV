/** Validação independente do banco: saldo e preço em créditos inteiros. */
export function totalPrepaidCredits(unitPriceCredits, quantity) {
  if (!Number.isSafeInteger(unitPriceCredits) || unitPriceCredits <= 0 ||
      !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 10000) return null;
  const total = unitPriceCredits * quantity;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

