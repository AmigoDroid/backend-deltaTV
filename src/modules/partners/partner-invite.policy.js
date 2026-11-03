import crypto from "node:crypto";
export const INVITE_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const normalizeInviteEmail = (v) => String(v).trim().toLowerCase();
export const hashInviteToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const generateInviteToken = () => crypto.randomBytes(32).toString("base64url");
export const escapeMailHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Parâmetro de consulta compatível com rastreamento/redirecionamento de links de e-mail.
// O frontend limpa o parâmetro antes de carregar o aplicativo. Recomendamos
// desabilitar o rastreamento de cliques para convites, pois o token é sensível.
export const inviteUrl = (origin, token) => `${origin}/?convite=${encodeURIComponent(token)}`;
export const inviteIsValid = (record, now = Date.now()) =>
  !!record && record.status === "invited" && !!record.expiresAt && new Date(record.expiresAt).getTime() > now;
