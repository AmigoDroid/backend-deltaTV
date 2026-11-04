import { markPartnerConfigured } from "./partner-onboarding.service.js";
import { pageOf, paged } from "../../shared/pagination.js";
import crypto from "node:crypto";
import { Op } from "sequelize";
import { sequelize, PartnerPreRegistration, Partner, AdminUser } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { hashPassword } from "../../shared/crypto.js";
import { audit } from "../../shared/audit.js";
import { sendMail, assertConfigured } from "../mail/mail.transport.js";
import { env } from "../../config/env.js";

import { INVITE_LIFETIME_MS, normalizeInviteEmail, hashInviteToken, generateInviteToken, escapeMailHtml, inviteUrl, inviteIsValid } from "./partner-invite.policy.js";
const present = (r) => ({
  id: r.id, name: r.name, email: r.email, status: r.status,
  createdAt: r.createdAt, updatedAt: r.updatedAt, emailSentAt: r.emailSentAt,
  expiresAt: r.expiresAt, completedAt: r.completedAt, configuredAt: r.configuredAt, completedPartnerId: r.completedPartnerId,
});
async function emailExists(email, transaction) {
  const user = await AdminUser.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email), attributes: ["id"], transaction });
  if (user) return true;
  return !!(await Partner.findOne({ where: {
    [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.col("contact_email")), email), { status: { [Op.ne]: "deleted" } }],
  }, attributes: ["id"], transaction }));
}

export async function listPreRegistrations({ view = "pending", page = 1, pageSize = 8 } = {}) {
  const pending = { configuredAt: null, status: { [Op.ne]: "cancelled" } };
  const history = { [Op.or]: [{ configuredAt: { [Op.ne]: null } }, { status: "cancelled" }] };
  const [{ rows, count }, pendingCount, historyCount, readyCount] = await Promise.all([
    PartnerPreRegistration.findAndCountAll({ where: view === "history" ? history : pending,
      order: [["createdAt", "DESC"], ["id", "DESC"]], ...pageOf({ page, pageSize }) }),
    PartnerPreRegistration.count({ where: pending }), PartnerPreRegistration.count({ where: history }),
    PartnerPreRegistration.count({ where: { configuredAt: null, status: "completed" } }),
  ]);
  return { ...paged(rows.map(present), count, { page, pageSize }),
    summary: { pending: pendingCount, history: historyCount, ready: readyCount } };
}

export async function finishPreRegistration(id, actor) {
  return sequelize.transaction(async (t) => {
    // Mesma ordem de locks das alterações de contrato: parceiro antes do convite.
    const candidate = await PartnerPreRegistration.findByPk(id, { transaction: t });
    if (!candidate) throw notFound("Pré-cadastro");
    if (candidate.status !== "completed" || !candidate.completedPartnerId)
      throw new AppError(409, "REGISTRATION_NOT_COMPLETED", "O parceiro precisa concluir o cadastro antes de finalizar a configuração.");
    const partner = await Partner.findByPk(candidate.completedPartnerId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!partner || partner.status === "deleted") throw notFound("Parceiro");
    await markPartnerConfigured(partner.id, actor, t);
    return present(await PartnerPreRegistration.findByPk(id, { transaction: t }));
  });
}

export async function createPreRegistration({ name, email, sendEmail }, actor) {
  const normalized = normalizeInviteEmail(email);
  if (await emailExists(normalized)) throw new AppError(409, "EMAIL_IN_USE", "Este e-mail já está cadastrado na plataforma.");
  const existing = await PartnerPreRegistration.findOne({ where: { email: normalized } });
  if (existing && existing.status !== "cancelled") throw new AppError(409, "PRE_REGISTRATION_EXISTS", "Este e-mail já possui pré-cadastro. Utilize a opção Enviar convite na listagem.");
  // O pré-cadastro nunca cria uma conta, parceiro, contrato ou licença.
  const invite = existing
    ? await (async () => {
        await existing.update({ name: name.trim(), createdBy: actor.id, status: "draft", tokenHash: null, expiresAt: null, emailSentAt: null });
        return existing;
      })()
    : await PartnerPreRegistration.create({ name: name.trim(), email: normalized, createdBy: actor.id, status: "draft" });
  await audit({ actor, action: "partner.pre_register", entityType: "partner_pre_registration", entityId: invite.id, metadata: { email: normalized, sendEmail } });
  if (!sendEmail) return { ...present(invite), emailSent: false };
  try {
    const sent = await sendPreRegistrationInvite(invite.id, actor);
    return { ...sent, emailSent: true };
  } catch (error) {
    // Registro salvo: o operador pode reenviar após configurar/corrigir SMTP.
    console.warn("[partner-invites] Falha no envio do convite:", error?.code || error?.name || "SMTP_ERROR");
    return { ...present(await PartnerPreRegistration.findByPk(invite.id)), emailSent: false, warning: "Pré-cadastro salvo, mas o e-mail não foi enviado. Confira o SMTP e use Enviar convite." };
  }
}

export async function sendPreRegistrationInvite(id, actor) {
  assertConfigured();
  const token = generateInviteToken();
  // A troca de token invalida todos os convites anteriores deste endereço.
  const invite = await sequelize.transaction(async (t) => {
    const row = await PartnerPreRegistration.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw notFound("Pré-cadastro");
    if (row.status === "completed" || row.status === "cancelled") throw new AppError(409, "INVITE_CLOSED", "Este pré-cadastro está concluído ou cancelado.");
    if (row.status === "sending" && Date.now() - new Date(row.updatedAt).getTime() < 120_000) throw new AppError(409, "INVITE_IN_PROGRESS", "O convite já está sendo enviado.");
    if (row.emailSentAt && Date.now() - new Date(row.emailSentAt).getTime() < 60_000) throw new AppError(429, "INVITE_COOLDOWN", "Aguarde um minuto para reenviar o convite.");
    if (await emailExists(row.email, t)) throw new AppError(409, "EMAIL_IN_USE", "Este e-mail já foi cadastrado.");
    await row.update({ tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + INVITE_LIFETIME_MS), status: "sending" }, { transaction: t });
    return row;
  });
  const url = inviteUrl(env.partnerPortalUrl, token);
  const name = escapeMailHtml(invite.name);
  const safeUrl = escapeMailHtml(url);
  const subject = "Delta TV — finalize seu cadastro de parceiro";
  try {
    await sendMail({
    to: invite.email, toName: invite.name, subject,
    text: `Olá, ${invite.name}!\n\nVocê recebeu um convite para cadastrar sua conta de parceiro na Delta TV.\n\nConclua seu cadastro e defina sua senha pelo link (válido por 72 horas):\n${url}\n\nSe não esperava este convite, ignore esta mensagem.\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:570px;margin:auto;color:#172033"><h2>Convite Delta TV</h2><p>Olá, <strong>${name}</strong>!</p><p>Você foi convidado para concluir seu cadastro como parceiro de conteúdo.</p><p><a href="${safeUrl}" style="display:inline-block;padding:14px 22px;border-radius:9px;background:#5844d4;color:white;text-decoration:none;font-weight:bold">Concluir meu cadastro</a></p><p>Este link expira em <strong>72 horas</strong> e só pode ser usado uma vez.</p><p style="font-size:13px;color:#64748b">Se não solicitou esse cadastro, ignore este e-mail.</p></div>`,
    });
  } catch (error) {
    // O registro permanece salvo, mas o convite não está válido quando o SMTP falha.
    await PartnerPreRegistration.update({ status: "draft", tokenHash: null, expiresAt: null }, { where: { id, tokenHash: hashInviteToken(token), status: "sending" } });
    throw error;
  }
  // Um reenvio concorrente não pode sobrescrever o estado de outro token.
  await PartnerPreRegistration.update({ status: "invited", emailSentAt: new Date() }, { where: { id, tokenHash: hashInviteToken(token), status: "sending" } });
  await audit({ actor, action: "partner.invite_sent", entityType: "partner_pre_registration", entityId: id, metadata: { email: invite.email } });
  return present(await PartnerPreRegistration.findByPk(id));
}

export async function cancelPreRegistration(id, actor) {
  const row = await sequelize.transaction(async (t) => {
    const record = await PartnerPreRegistration.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!record) throw notFound("Pré-cadastro");
    if (record.status === "completed") throw new AppError(409, "INVITE_COMPLETED", "Não é possível cancelar uma conta já cadastrada.");
    await record.update({ status: "cancelled", tokenHash: null, expiresAt: null }, { transaction: t });
    return record;
  });
  await audit({ actor, action: "partner.invite_cancelled", entityType: "partner_pre_registration", entityId: id });
  return present(row);
}

function invalidInvite() { return new AppError(400, "INVALID_INVITE", "Convite inválido, cancelado ou expirado. Solicite um novo ao administrador."); }

export async function verifyPreRegistration(token) {
  const r = await PartnerPreRegistration.findOne({ where: { tokenHash: hashInviteToken(token), status: "invited" } });
  if (!inviteIsValid(r)) throw invalidInvite();
  return { name: r.name, email: r.email, expiresAt: r.expiresAt };
}

export async function completePreRegistration({ token, companyName, password }) {
  // A hash é calculada fora da transação, para não segurar locks do banco em uma operação lenta.
  const passwordHash = await hashPassword(password);
  return sequelize.transaction(async (t) => {
    const r = await PartnerPreRegistration.findOne({ where: { tokenHash: hashInviteToken(token) }, transaction: t, lock: t.LOCK.UPDATE });
    if (!inviteIsValid(r)) throw invalidInvite();
    if (await emailExists(r.email, t)) throw new AppError(409, "EMAIL_IN_USE", "Este e-mail já está cadastrado. Entre em contato com a administração.");
    const now = new Date();
    const endsAt = new Date(now); endsAt.setUTCFullYear(endsAt.getUTCFullYear() + 1);
    // Não cria créditos, servidores, códigos ou contrato. O admin configura as condições comerciais depois.
    const slug = `parceiro-${crypto.randomBytes(7).toString("hex")}`;
    const p = await Partner.create({
      name: companyName.trim(), slug, contactName: r.name, contactEmail: r.email,
      kind: "content", billingModel: "none", status: "active", startsAt: now, endsAt,
    }, { transaction: t });
    const user = await AdminUser.create({
      name: r.name, email: r.email, passwordHash, role: "partner", partnerId: p.id, status: "active",
    }, { transaction: t });
    await r.update({ status: "completed", tokenHash: null, expiresAt: null, completedAt: now, completedPartnerId: p.id }, { transaction: t });
    await audit({ actor: { type: "anonymous", id: null }, action: "partner.invite_completed", entityType: "partner", entityId: p.id, metadata: { invitedEmail: r.email, portalUserId: user.id }, transaction: t });
    return { ok: true, message: "Cadastro concluído. Entre no painel do parceiro usando seu e-mail e senha." };
  });
}
