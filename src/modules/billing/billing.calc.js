import { AppError } from "../../shared/errors.js";

/**
 * Cálculo da mensalidade do parceiro. 100% orientado a dados (sem alterar código por contrato):
 *  - fixed:      valor mensal fixo
 *  - per_device: dispositivos × valor unitário (respeitando mínimo)
 *  - tiered:     preço fechado da faixa em que o total de dispositivos se encaixa
 * Valores sempre em centavos (inteiros).
 */
export function calculateAmount(partner, deviceCount) {
  const count = Math.max(0, Number(deviceCount) || 0);
  const min = Number(partner.minFeeCents) || 0;
  let amount;
  let rule;

  switch (partner.billingModel) {
    case "fixed":
      amount = Number(partner.monthlyFeeCents) || 0;
      rule = "fixed";
      break;
    case "per_device":
      amount = Math.max(min, (Number(partner.perDeviceCents) || 0) * count);
      rule = `${count} x ${partner.perDeviceCents}`;
      break;
    case "tiered": {
      const tiers = normalizeTiers(partner.tiers);
      const tier = tiers.find((t) => t.upTo === null || count <= t.upTo);
      if (!tier) throw new AppError(422, "NO_TIER", "Nenhuma faixa de cobrança cobre a quantidade de dispositivos.");
      amount = Math.max(min, tier.amountCents);
      rule = tier.upTo === null ? "faixa final" : `até ${tier.upTo}`;
      break;
    }
    default:
      throw new AppError(422, "INVALID_BILLING_MODEL", "Modelo de cobrança inválido.");
  }
  return { amountCents: amount, breakdown: { model: partner.billingModel, deviceCount: count, rule, minFeeCents: min } };
}

export function normalizeTiers(tiers) {
  const list = (Array.isArray(tiers) ? tiers : []).map((t) => ({
    upTo: t.upTo === null || t.upTo === undefined ? null : Number(t.upTo),
    amountCents: Number(t.amountCents),
  }));
  return list.sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
}
