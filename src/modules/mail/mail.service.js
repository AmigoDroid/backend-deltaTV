import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { paged } from "../../shared/pagination.js";
import { resolveRecipients } from "./mail.recipients.js";
import { renderMail } from "./mail.render.js";
import { assertConfigured, sendMail } from "./mail.transport.js";
import { workerState } from "./mail.worker.js";

const q = (text, replacements = {}, opts = {}) => sequelize.query(text, { replacements, type: QueryTypes.SELECT, ...opts });
const COUNTS = `count(d.id)::int AS total_rows,
  count(*) FILTER (WHERE d.status = 'sent')::int AS sent,
  count(*) FILTER (WHERE d.status = 'failed')::int AS failed,
  count(*) FILTER (WHERE d.status IN ('pending','sending'))::int AS pending,
  count(*) FILTER (WHERE d.status = 'cancelled')::int AS cancelled`;
const view = (r) => ({
  id: r.id, subject: r.subject, audience: r.audience, audienceLabel: r.audience_label, createdByName: r.created_by_name,
  createdAt: r.created_at, total: r.total, sent: r.sent, failed: r.failed, pending: r.pending, cancelled: r.cancelled,
  ...(r.body !== undefined ? { body: r.body } : {}),
});

/** Estado do servidor de e-mail para o painel. Nunca devolve usuário nem senha do SMTP. */
export async function status() {
  const [{ pending }] = await q(`SELECT count(*)::int AS pending FROM email_deliveries WHERE status IN ('pending','sending')`);
  const m = env.mail;
  return {
    configured: m.configured, host: m.host || null, port: m.host ? m.port : null, secure: m.secure, from: m.from || null,
    replyTo: m.replyTo || null, ratePerMinute: m.ratePerMinute, maxRecipients: m.maxRecipients, queued: pending,
    lastError: workerState.lastError, lastErrorAt: workerState.lastErrorAt,
  };
}

/** Envia UM e-mail de teste direto (sem fila) para o próprio administrador: mostra o erro real do SMTP, se houver. */
export async function sendTest({ to, name }) {
  assertConfigured();
  const mail = renderMail(
    { subject: "Teste de e-mail do painel", body: "Olá {{nome}},\n\nSe você recebeu esta mensagem, o servidor de e-mail do painel está funcionando.", name, email: to },
    { footer: env.mail.footer },
  );
  try {
    await sendMail({ to, toName: name, ...mail });
  } catch (e) {
    throw new AppError(502, "SMTP_ERROR", `O servidor SMTP recusou o envio: ${String(e.message).slice(0, 300)}`);
  }
  return { ok: true, to };
}

export async function previewAudience(input) {
  const { list, skipped, label } = await resolveRecipients(input);
  return { label, total: list.length, skipped, sample: list.slice(0, 5) };
}

/** Grava a mensagem e enfileira um envio por destinatário. O envio em si acontece no worker (ritmo limitado). */
export async function createMessage({ subject, body, ...input }, actor) {
  assertConfigured();
  const { list, label } = await resolveRecipients(input);
  if (!list.length) throw new AppError(422, "NO_RECIPIENTS", "Nenhum destinatário com e-mail válido neste público.");
  return sequelize.transaction(async (transaction) => {
    const [m] = await q(
      `INSERT INTO email_messages (subject, body, audience, audience_label, created_by, created_by_name, total)
       VALUES (:subject, :body, :audience, :label, :by, :byName, :total) RETURNING id`,
      { subject: subject.trim(), body, audience: input.audience, label, by: actor?.id ?? null, byName: actor?.name ?? null, total: list.length },
      { transaction },
    );
    await q(
      `INSERT INTO email_deliveries (message_id, to_email, to_name)
       SELECT :id, x.email, NULLIF(x.name, '') FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x(email text, name text)`,
      { id: m.id, rows: JSON.stringify(list) },
      { transaction },
    );
    await audit({ actor, action: "mail.send", entityType: "email_message", entityId: m.id, metadata: { audience: input.audience, total: list.length, subject: subject.trim() }, transaction });
    return getMessage(m.id, { page: 1, pageSize: 1 }, { transaction });
  });
}

export async function listMessages({ page, pageSize }) {
  const rows = await q(
    `SELECT m.id, m.subject, m.audience, m.audience_label, m.created_by_name, m.total, m.created_at, ${COUNTS}
       FROM email_messages m LEFT JOIN email_deliveries d ON d.message_id = m.id
      GROUP BY m.id ORDER BY m.created_at DESC LIMIT :limit OFFSET :offset`,
    { limit: pageSize, offset: (page - 1) * pageSize },
  );
  const [{ total }] = await q(`SELECT count(*)::int AS total FROM email_messages`);
  return paged(rows.map(view), total, { page, pageSize });
}

export async function getMessage(id, { page = 1, pageSize = 50, status: st } = {}, opts = {}) {
  const [m] = await q(
    `SELECT m.*, ${COUNTS} FROM email_messages m LEFT JOIN email_deliveries d ON d.message_id = m.id WHERE m.id = :id GROUP BY m.id`,
    { id }, opts,
  );
  if (!m) throw notFound("Mensagem");
  const where = st ? "AND status = :st" : "";
  const rows = await q(
    `SELECT id, to_email, to_name, status, attempts, error, sent_at FROM email_deliveries
      WHERE message_id = :id ${where}
      ORDER BY (status = 'failed') DESC, to_email LIMIT :limit OFFSET :offset`,
    { id, st: st ?? null, limit: pageSize, offset: (page - 1) * pageSize }, opts,
  );
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM email_deliveries WHERE message_id = :id ${where}`, { id, st: st ?? null }, opts);
  return {
    ...view(m),
    deliveries: paged(rows.map((r) => ({ id: r.id, email: r.to_email, name: r.to_name, status: r.status, attempts: r.attempts, error: r.error, sentAt: r.sent_at })), n, { page, pageSize }),
  };
}

/** Falhas voltam para a fila (zera tentativas). */
export async function retryFailed(id, actor) {
  await getMessage(id, { pageSize: 1 });
  const rows = await q(
    `UPDATE email_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_at = NULL, error = NULL
      WHERE message_id = :id AND status = 'failed' RETURNING id`, { id },
  );
  await audit({ actor, action: "mail.retry", entityType: "email_message", entityId: id, metadata: { requeued: rows.length } });
  return { requeued: rows.length };
}

/** Cancela o que ainda não saiu. O que já foi enviado não volta. */
export async function cancelPending(id, actor) {
  await getMessage(id, { pageSize: 1 });
  const rows = await q(
    `UPDATE email_deliveries SET status = 'cancelled', locked_at = NULL WHERE message_id = :id AND status = 'pending' RETURNING id`, { id },
  );
  await audit({ actor, action: "mail.cancel", entityType: "email_message", entityId: id, metadata: { cancelled: rows.length } });
  return { cancelled: rows.length };
}
