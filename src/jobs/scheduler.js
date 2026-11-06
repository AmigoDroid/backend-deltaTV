import { reconcile as reconcilePix } from "../modules/pix/pix.service.js";
import { generateForAll, sweepDelinquency, lastClosedCompetence, recoverMissedInvoices } from "../modules/billing/billing.service.js";
import { startMailWorker } from "../modules/mail/mail.worker.js";

// Rotina horária e idempotente: gera a cobrança do mês e aplica a política de inadimplência.
export async function runBillingJobs({ recovery = false } = {}) {
  // A verificação diária recupera meses não faturados após períodos de offline.
  // A execução horária continua leve, apurando somente a última competência.
  const lookback = Number.parseInt(process.env.BILLING_RECOVERY_MONTHS ?? "6", 10);
  const invoices = recovery ? await recoverMissedInvoices({ months: Math.max(1, Math.min(60, lookback || 6)),
      graceDays: Number.parseInt(process.env.BILLING_RECOVERY_GRACE_DAYS ?? "7", 10) || 7 })
    : await generateForAll(lastClosedCompetence());
  if (recovery && invoices.failed) console.error(`[jobs] falhas na recuperação de ${invoices.failed} competência(s):`,
    invoices.results.filter((r) => !r.ok));
  const sweep = await sweepDelinquency();
  console.log(`[jobs] faturas criadas: ${invoices.created}; vencidas: ${sweep.markedOverdue}; parcerias suspensas: ${sweep.suspended.length}`);
}

// Conciliação do Pix a cada 2 min: confirma pagamentos cujo webhook se perdeu e expira QR Codes vencidos.
export async function runPixJobs() {
  const r = await reconcilePix();
  if (r.checked || r.paid || r.expired) console.log(`[jobs] pix conferidos: ${r.checked}; pagos: ${r.paid}; expirados: ${r.expired}`);
}

export function startScheduler() {
  let billingRunning = false;
  const safe = async (recovery = false) => {
    if (billingRunning) return;
    billingRunning = true;
    try { await runBillingJobs({ recovery }); }
    catch (e) { console.error("[jobs] falha:", e.message); }
    finally { billingRunning = false; }
  };
  setTimeout(() => { void safe(true); }, 15_000).unref();
  setInterval(() => { void safe(false); }, 60 * 60 * 1000).unref();
  setInterval(() => { void safe(true); }, 24 * 60 * 60 * 1000).unref();
  const safePix = () => runPixJobs().catch((e) => console.error("[jobs] pix falhou:", e.message));
  setTimeout(safePix, 20_000).unref();
  setInterval(safePix, 2 * 60 * 1000).unref();
  startMailWorker(); // fila de e-mails (só age se SMTP_HOST/MAIL_FROM estiverem definidos)
}
