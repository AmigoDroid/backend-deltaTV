/**
 * Regra de preços (pura, sem banco): junta as linhas da tabela geral (partnerId nulo) com as do revendedor.
 * O preço do revendedor sobrepõe o geral; com active=false a duração deixa de ser vendida para ele.
 */
export function resolvePrices(rows) {
  const map = new Map();
  for (const r of rows) if (!r.partnerId && r.active) map.set(r.months, { months: r.months, priceCents: r.priceCents, custom: false });
  for (const r of rows) {
    if (!r.partnerId) continue;
    if (r.active) map.set(r.months, { months: r.months, priceCents: r.priceCents, custom: true });
    else map.delete(r.months);
  }
  return [...map.values()].sort((a, b) => a.months - b.months);
}
