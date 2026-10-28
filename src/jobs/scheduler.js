import { currentCompetence } from "../shared/dates.js";
import { reconcile as reconcilePix } from "../modules/pix/pix.service.js";
import { generateForAll, sweepDelinquency } from "../modules/billing/billing.service.js";
import { startMailWorker } from "../modules/mail/mail.worker.js";

// Rotina horária e idempotente: gera a cobrança do mês e aplica a política de inadimplência.
export async function runBillingJobs() {
  const invoices = await generateForAll(currentCompetence());
  const sweep = await sweepDelinquency();
  console.log(`[jobs] faturas criadas: ${invoices.created}; vencidas: ${sweep.markedOverdue}; parcerias suspensas: ${sweep.suspended.length}`);
}

// Conciliação do Pix a cada 2 min: confirma pagamentos cujo webhook se perdeu e expira QR Codes vencidos.
export async function runPixJobs() {
  const r = await reconcilePix();
  if (r.checked || r.paid || r.expired) console.log(`[jobs] pix conferidos: ${r.checked}; pagos: ${r.paid}; expirados: ${r.expired}`);
}

export function startScheduler() {
  const safe = () => runBillingJobs().catch((e) => console.error("[jobs] falha:", e.message));
  setTimeout(safe, 15_000).unref();
  setInterval(safe, 60 * 60 * 1000).unref();
  const safePix = () => runPixJobs().catch((e) => console.error("[jobs] pix falhou:", e.message));
  setTimeout(safePix, 20_000).unref();
  setInterval(safePix, 2 * 60 * 1000).unref();
  startMailWorker(); // fila de e-mails (só age se SMTP_HOST/MAIL_FROM estiverem definidos)
}
