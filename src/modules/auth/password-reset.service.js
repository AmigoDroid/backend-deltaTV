import { Op } from "sequelize";
import { sequelize, AdminUser, Partner } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError, notFound } from "../../shared/errors.js";
import { hashPassword, randomToken, sha256 } from "../../shared/crypto.js";
import { audit } from "../../shared/audit.js";
import { assertConfigured, sendMail } from "../mail/mail.transport.js";
import { revokeAllSessions } from "./auth.service.js";
import { disconnectAdminUser } from "../../realtime/socket.js";

export const RESET_TTL_MS = 30 * 60_000;
export const PUBLIC_COOLDOWN_MS = 15 * 60_000;
export const AUTH_COOLDOWN_MS = 60_000;
const GENERAL_RESPONSE = { ok: true, message: "Se existir uma conta elegível para este e-mail, você receberá as instruções." };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function resetLinkForRole(role, token, partnerKind = null) {
  const origin = role !== "partner" ? env.adminPanelUrl : partnerKind === "reseller" ? env.resellerPortalUrl : env.partnerPortalUrl;
  // O fragmento não é enviado ao servidor web nem em cabeçalhos Referer.
  return `${origin}/redefinir-senha#token=${encodeURIComponent(token)}`;
}

async function dispatchForUser(userId, { actor, cooldownMs, generic = false } = {}) {
  // No fluxo público não mostramos se o e-mail existe ou se o SMTP falhou.
  if (!env.mail.configured) {
    if (generic) return false;
    assertConfigured();
  }
  const token = randomToken(48);
  const digest = sha256(token);
  const issued = await sequelize.transaction(async (transaction) => {
    // Trava a conta para serializar pedidos e evitar que uma resposta anterior sobrescreva a última.
    const user = await AdminUser.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!user || user.status !== "active") {
      if (generic) return null;
      throw notFound("Usuário ativo");
    }
    if (user.passwordResetIssuedAt && Date.now() - new Date(user.passwordResetIssuedAt).getTime() < cooldownMs) {
      if (generic) return null;
      throw new AppError(429, "RESET_RECENTLY_SENT", "Um link foi solicitado recentemente. Aguarde antes de reenviar.");
    }
    await user.update({ passwordResetHash: digest, passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MS), passwordResetIssuedAt: new Date() }, { transaction });
    return { id: user.id, name: user.name, email: user.email, role: user.role, partnerId: user.partnerId };
  });
  if (!issued) return false;

  const partner = issued.role === "partner" && issued.partnerId ? await Partner.findByPk(issued.partnerId, { attributes: ["kind"] }) : null;
  const link = resetLinkForRole(issued.role, token, partner?.kind);
  const displayName = escapeHtml(issued.name || "parceiro");
  const safeLink = escapeHtml(link);
  try {
    await sendMail({
      to: issued.email, toName: issued.name,
      subject: "DeltaTV | Redefinição de senha",
      text: `Olá, ${issued.name || "usuário"}!\n\nUse este link para redefinir sua senha:\n${link}\n\nO link expira em 30 minutos e só pode ser usado uma vez. Se não solicitou a mudança, ignore este e-mail.\n`,
      html: `<div style="max-width:580px;margin:auto;font:15px Arial,sans-serif;color:#172033"><h2>Redefinir senha da DeltaTV</h2><p>Olá, ${displayName}!</p><p>Recebemos um pedido para redefinir sua senha.</p><p><a style="display:inline-block;padding:14px 22px;background:#6253cd;color:white;text-decoration:none;border-radius:8px" href="${safeLink}">Criar nova senha</a></p><p>O link expira em <strong>30 minutos</strong> e funciona somente uma vez.</p><p style="font-size:13px;color:#64748b">Se você não fez esta solicitação, pode ignorar esta mensagem. Sua senha atual continua válida.</p></div>`,
    });
  } catch (error) {
    // Nunca manter um token válido cujo e-mail falhou. A condição protege um eventual envio novo.
    await AdminUser.update({ passwordResetHash: null, passwordResetExpiresAt: null, passwordResetIssuedAt: null }, { where: { id: issued.id, passwordResetHash: digest } });
    if (generic) {
      console.warn("[password-reset] Falha no envio SMTP para solicitação pública:", error.code || "SMTP_ERROR");
      return false;
    }
    throw new AppError(502, "PASSWORD_RESET_MAIL_FAILED", "Não foi possível enviar o e-mail. Confira a configuração SMTP e tente novamente.");
  }
  await audit({ actor, action: "auth.password_reset_sent", entityType: "admin_user", entityId: issued.id, metadata: { channel: generic ? "forgot" : "authenticated" } });
  return true;
}

/** Sempre devolve a mesma resposta pública, inclusive para endereço desconhecido. */
export async function requestPasswordReset(email, meta = {}) {
  const normalized = String(email).trim().toLowerCase();
  const user = await AdminUser.findOne({
    where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), normalized),
    attributes: ["id", "status", "role", "partnerId"],
  });
  if (user?.status === "active" && user.role === "partner" && user.partnerId) {
    const partner = await Partner.findByPk(user.partnerId, { attributes: ["id", "kind"] });
    if (partner && ["content", "both"].includes(partner.kind)) {
      await dispatchForUser(user.id, { generic: true, cooldownMs: PUBLIC_COOLDOWN_MS, actor: { type: "anonymous", ip: meta.ip } });
    }
  }
  return GENERAL_RESPONSE;
}

/** Usado pelo admin (qualquer usuário permitido pelo seu escopo) ou pelo próprio parceiro autenticado. */
export async function sendPasswordResetToUser(userId, actor) {
  await dispatchForUser(userId, { actor, cooldownMs: AUTH_COOLDOWN_MS });
  return { ok: true, message: "O link de redefinição foi enviado para o e-mail cadastrado." };
}

/** Uso único e expiração são verificados sob a trava da própria conta. */
export async function completePasswordReset(token, newPassword, meta = {}) {
  const digest = sha256(token);
  const passwordHash = await hashPassword(newPassword);
  const changedId = await sequelize.transaction(async (transaction) => {
    const user = await AdminUser.findOne({
      where: { passwordResetHash: digest, passwordResetExpiresAt: { [Op.gt]: new Date() }, status: "active" },
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!user) throw new AppError(400, "INVALID_RESET_TOKEN", "Link inválido, já utilizado ou expirado. Solicite um novo.");
    await user.update({ passwordHash, passwordResetHash: null, passwordResetExpiresAt: null, passwordResetIssuedAt: null, failedLogins: 0, lockedUntil: null }, { transaction });
    await revokeAllSessions(user.id, transaction);
    await audit({ actor: { type: "anonymous", ip: meta.ip }, action: "auth.password_reset_completed", entityType: "admin_user", entityId: user.id, transaction });
    return user.id;
  });
  disconnectAdminUser(changedId);
  return { ok: true, message: "Senha alterada. Entre novamente com sua nova senha." };
}
