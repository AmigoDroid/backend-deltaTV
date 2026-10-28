import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { renderMail } from "./mail.render.js";
import { sendMail } from "./mail.transport.js";

/**
 * Worker da fila de e-mails. A cada 10 s pega algumas entregas pendentes (FOR UPDATE SKIP LOCKED: vários processos não enviam
 * o mesmo e-mail) e envia no ritmo MAIL_RATE_PER_MINUTE, para não estourar o limite do provedor SMTP nem cair em spam.
 *  - Erro 5xx do destinatário (caixa não existe etc.) = falha definitiva.
 *  - Erro temporário (4xx, rede, timeout) = volta para a fila com espera crescente, até MAX_ATTEMPTS.
 *  - Erro de login/conexão com o SMTP = problema NOSSO: a entrega volta à fila, o ciclo para e o erro aparece no painel.
 */
export const MAX_ATTEMPTS = 5;
export const workerState = { lastError: null, lastErrorAt: null, running: false };
const SERVER_SIDE = new Set(["EAUTH", "ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED"]);
const q = (text, replacements = {}) => sequelize.query(text, { replacements, type: QueryTypes.SELECT });

export const isPermanent = (e) => !SERVER_SIDE.has(e?.code) && Number(e?.responseCode) >= 500 && Number(e?.responseCode) <= 599;
export const backoffMinutes = (attempts) => Math.min(60, 2 ** attempts);

async function claim(limit) {
  return q(
    `UPDATE email_deliveries SET status = 'sending', attempts = attempts + 1, locked_at = now()
      WHERE id IN (
        SELECT id FROM email_deliveries
         WHERE (status = 'pending' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_at < now() - interval '5 minutes')
         ORDER BY created_at, id LIMIT :limit FOR UPDATE SKIP LOCKED)
      RETURNING id, message_id, to_email, to_name, attempts`,
    { limit },
  );
}

/** Processa um lote. Devolve { sent, failed, retried }. Exportada para os testes e para disparo manual. */
export async function processQueue({ limit = Math.max(1, Math.ceil(env.mail.ratePerMinute / 6)) } = {}) {
  const out = { sent: 0, failed: 0, retried: 0 };
  if (!env.mail.configured) return out;
  const batch = await claim(limit);
  const messages = new Map();
  for (const d of batch) {
    let msg = messages.get(d.message_id);
    if (!msg) {
      [msg] = await q(`SELECT subject, body FROM email_messages WHERE id = :id`, { id: d.message_id });
      messages.set(d.message_id, msg);
    }
    try {
      await sendMail({ to: d.to_email, toName: d.to_name, ...renderMail({ subject: msg.subject, body: msg.body, name: d.to_name, email: d.to_email }, { footer: env.mail.footer }) });
      await q(`UPDATE email_deliveries SET status = 'sent', sent_at = now(), locked_at = NULL, error = NULL WHERE id = :id`, { id: d.id });
      workerState.lastError = null;
      out.sent += 1;
    } catch (e) {
      const message = String(e?.message ?? e).slice(0, 480);
      const serverSide = SERVER_SIDE.has(e?.code);
      if (isPermanent(e) || (!serverSide && d.attempts >= MAX_ATTEMPTS)) {
        await q(`UPDATE email_deliveries SET status = 'failed', locked_at = NULL, error = :message WHERE id = :id`, { id: d.id, message });
        out.failed += 1;
      } else {
        // Problema do servidor SMTP não gasta tentativa do destinatário: devolve a que foi contada na reserva.
        await q(
          `UPDATE email_deliveries SET status = 'pending', locked_at = NULL, error = :message, attempts = GREATEST(0, attempts - :undo),
                  next_attempt_at = now() + make_interval(mins => :wait) WHERE id = :id`,
          { id: d.id, message, undo: serverSide ? 1 : 0, wait: serverSide ? 5 : backoffMinutes(d.attempts) },
        );
        out.retried += 1;
      }
      if (serverSide) {
        workerState.lastError = message;
        workerState.lastErrorAt = new Date().toISOString();
        // Devolve o restante do lote sem tentar: o SMTP está fora ou a credencial está errada.
        const rest = batch.slice(batch.indexOf(d) + 1).map((r) => r.id);
        if (rest.length) await q(`UPDATE email_deliveries SET status = 'pending', locked_at = NULL, attempts = GREATEST(0, attempts - 1) WHERE id IN (:ids)`, { ids: rest });
        break;
      }
    }
  }
  return out;
}

export function startMailWorker() {
  const tick = async () => {
    if (workerState.running || !env.mail.configured) return;
    workerState.running = true;
    try {
      const r = await processQueue();
      if (r.sent || r.failed || r.retried) console.log(`[mail] enviados: ${r.sent}; falhas: ${r.failed}; reenfileirados: ${r.retried}`);
    } catch (e) {
      console.error("[mail] falha no ciclo:", e.message);
    } finally {
      workerState.running = false;
    }
  };
  setTimeout(tick, 10_000).unref();
  setInterval(tick, 10_000).unref();
}
