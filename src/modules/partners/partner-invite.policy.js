import crypto from "node:crypto";
export const INVITE_LIFETIME_MS = 72 * 60 * 60 * 1000;
export const normalizeInviteEmail = (v) => String(v).trim().toLowerCase();
export const hashInviteToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
export const generateInviteToken = () => crypto.randomBytes(32).toString("base64url");
export const escapeMailHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Rota pública dedicada: o cliente recebe /convite/TOKEN, sem precisar fazer login.
// A validação permanece exclusivamente na API usando o corpo de um POST.
export const inviteUrl = (origin, token) => `${origin.replace(/\/+$/, "")}/convite/${encodeURIComponent(token)}`;
export const inviteIsValid = (record, now = Date.now()) =>
  !!record && record.status === "invited" && !!record.expiresAt && new Date(record.expiresAt).getTime() > now;
