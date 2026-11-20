import { reconcile as reconcilePix } from "../modules/pix/pix.service.js";
import { recoverStaleCreatingCharges } from "../modules/network-finance/finance.service.js";
import { reconcilePending as reconcileMasterPix } from "../modules/distribution/master-pix.service.js";
import { generateForAll, sweepDelinquency, lastClosedCompetence, recoverMissedInvoices } from "../modules/billing/billing.service.js";
import { startMailWorker } from "../modules/mail/mail.worker.js";
import {cleanupUsage} from "../modules/partner-portal-usage/usage.service.js";
import {sweepExpiredCommercialInvites} from "../modules/partner-portal-sales/invitations.service.js";

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
  const stale = await recoverStaleCreatingCharges();
  if(stale.checked) console.warn(`[jobs] cobranças em criação sem confirmação: ${stale.checked} inspecionadas, ${stale.needsReview} para revisão manual`);
  const m = await reconcileMasterPix();
  if (m.checked || m.errors) console.log(`[jobs] pix master: ${m.checked} conferidos, ${m.paid} pagos, ${m.errors} erros`);
  if (r.checked || r.paid || r.expired) console.log(`[jobs] pix conferidos: ${r.checked}; pagos: ${r.paid}; expirados: ${r.expired}`);
}

export function startScheduler() {
  let stopped = false;
  const timers = [];
  const after = (fn,ms) => {const handle=setTimeout(()=>{if(!stopped)fn();},ms);handle.unref?.();timers.push(handle);};
  const every = (fn,ms) => {const handle=setInterval(()=>{if(!stopped)fn();},ms);handle.unref?.();timers.push(handle);};
  let billingRunning = false;
  const safe = async (recovery = false) => {
    if (stopped || billingRunning) return;
    billingRunning = true;
    try { await runBillingJobs({ recovery }); }
    catch (e) { console.error("[jobs] falha:", e.message); }
    finally { billingRunning = false; }
  };
  after(() => { void safe(true); }, 15_000);
  every(() => { void safe(false); }, 60 * 60 * 1000);
  every(() => { void safe(true); }, 24 * 60 * 60 * 1000);
  const safePix = () => runPixJobs().catch((e) => console.error("[jobs] pix falhou:", e.message));
  after(safePix, 20_000);
  every(safePix, 2 * 60 * 1000);
  // Expira reservas comerciais a cada 5 minutos. Nunca afeta licenças de TV.
  let commercialSweepRunning=false;
  const commercialSweep=async()=>{
    if(stopped || commercialSweepRunning)return;
    commercialSweepRunning=true;
    try{const result=await sweepExpiredCommercialInvites();if(result.expired)console.info(`[portal-sales] ${result.expired} convites vencidos: estoque devolvido`);}
    catch(e){console.warn('[portal-sales] expiração de convites falhou:',e.message)}
    finally{commercialSweepRunning=false;}
  };
  after(()=>void commercialSweep(),25_000);
  every(()=>void commercialSweep(),5*60*1000);
  // Limpa apenas os agregados antigos: não altera contratos ou ativações.
  const usageCleanup=()=>cleanupUsage().catch(e=>console.warn('[portal-usage] retenção:',e.message));
  after(usageCleanup,50_000);
  every(usageCleanup,24*60*60*1000);
  startMailWorker(); // fila de e-mails (só age se SMTP_HOST/MAIL_FROM estiverem definidos)
  return () => {stopped=true;for(const handle of timers){clearInterval(handle);clearTimeout(handle);}};
}
