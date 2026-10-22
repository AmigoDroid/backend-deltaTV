import { currentCompetence } from "../shared/dates.js";
import { generateForAll, sweepDelinquency } from "../modules/billing/billing.service.js";

// Rotina horária e idempotente: gera a cobrança do mês e aplica a política de inadimplência.
export async function runBillingJobs() {
  const invoices = await generateForAll(currentCompetence());
  const sweep = await sweepDelinquency();
  console.log(`[jobs] faturas criadas: ${invoices.created}; vencidas: ${sweep.markedOverdue}; parcerias suspensas: ${sweep.suspended.length}`);
}

export function startScheduler() {
  const safe = () => runBillingJobs().catch((e) => console.error("[jobs] falha:", e.message));
  setTimeout(safe, 15_000).unref();
  setInterval(safe, 60 * 60 * 1000).unref();
}
