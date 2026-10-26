import { Plan } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";

export const MIN_MONTHS = 1;
export const MAX_MONTHS = 120;

export const planNameFor = (months) => `Individual ${months} ${months === 1 ? "mês" : "meses"}`;

/**
 * Plano de licença individual com qualquer duração de 1 a 120 meses. Reaproveita o plano `individual-{n}m`
 * (os de 4/6/12 meses já existem) ou cria na hora. Nunca altera um plano existente.
 */
export async function ensurePlan(months, { transaction, priceCents } = {}) {
  if (!Number.isInteger(months) || months < MIN_MONTHS || months > MAX_MONTHS) {
    throw new AppError(422, "INVALID_MONTHS", `A duração deve ser de ${MIN_MONTHS} a ${MAX_MONTHS} meses.`);
  }
  const code = `individual-${months}m`;
  const [plan] = await Plan.findOrCreate({
    where: { code },
    defaults: { code, name: planNameFor(months), durationMonths: months, maxDevices: 1, priceCents: priceCents ?? 0, active: true },
    transaction,
  });
  if (!plan.active) throw new AppError(422, "INVALID_PLAN", "Este plano está desativado.");
  return plan;
}
