import nodemailer from "nodemailer";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";

/**
 * Transporte SMTP (nodemailer) criado só no primeiro envio. Com usuário/senha, o STARTTLS é obrigatório (exceto SMTP_REQUIRE_TLS=false):
 * a credencial nunca trafega em texto puro. `setTransport` existe para os testes.
 */
let transport = null;
export const setTransport = (t) => { transport = t; };

function getTransport() {
  if (transport) return transport;
  const m = env.mail;
  transport = nodemailer.createTransport({
    host: m.host, port: m.port, secure: m.secure, requireTLS: m.requireTls,
    auth: m.user ? { user: m.user, pass: m.pass } : undefined,
    pool: true, maxConnections: 2, maxMessages: 100,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  return transport;
}

export function assertConfigured() {
  if (!env.mail.configured) {
    throw new AppError(409, "MAIL_NOT_CONFIGURED", "Servidor de e-mail não configurado. Defina SMTP_HOST e MAIL_FROM no .env e reinicie.");
  }
}

export async function sendMail({ to, toName, subject, text, html }) {
  assertConfigured();
  const safeName = String(toName ?? "").replace(/[\r\n"<>]/g, " ").trim();
  return getTransport().sendMail({
    from: env.mail.from,
    ...(env.mail.replyTo ? { replyTo: env.mail.replyTo } : {}),
    to: safeName ? { name: safeName, address: to } : to,
    subject, text, html,
  });
}
