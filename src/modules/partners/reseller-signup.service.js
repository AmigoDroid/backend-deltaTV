import crypto from "node:crypto";
import { UniqueConstraintError } from "sequelize";
import { sequelize, Partner, AdminUser } from "../../db/models/index.js";
import { audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { AppError } from "../../shared/errors.js";

/**
 * Autocadastro de revendedor (tela pública do portal do revendedor).
 *
 * O cadastro nasce SUSPENSO com este motivo ("aguardando aprovação"): a pessoa já consegue entrar no portal, mas nada
 * funciona até o admin aprovar (botão "Reativar" na parceria). Recusar = "Bloquear" com o motivo.
 * Sem migration: usa os campos existentes (status + statusReason).
 */
export const SIGNUP_PENDING_REASON = "Aguardando aprovação do cadastro";
export const isPendingSignup = (p) => p?.status === "suspended" && p?.statusReason === SIGNUP_PENDING_REASON;

// RESELLER_SIGNUP_ENABLED=false desliga o cadastro público sem novo deploy de código. Padrão: ligado.
export const signupEnabled = () => String(process.env.RESELLER_SIGNUP_ENABLED ?? "true").toLowerCase() !== "false";

const slugify = (name) => {
  const base = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `${base || "revenda"}-${crypto.randomBytes(3).toString("hex")}`;
};

/**
 * Cria o revendedor (pendente) + o usuário do portal. A resposta é SEMPRE a mesma, exista ou não o e-mail:
 * não revela quais e-mails já têm conta (e-mail repetido não cria nada).
 */
export async function registerReseller({ name, contactName, email, phone, password }, meta) {
  if (!signupEnabled()) throw new AppError(404, "NOT_FOUND", "Rota não encontrada.");
  const actor = { type: "anonymous", id: null, ip: meta.ip };
  const mail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password); // sempre calcula (iguala o tempo de resposta nos dois caminhos)

  const taken = await AdminUser.findOne({ where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), mail) });
  if (taken) {
    await audit({ actor, action: "reseller.signup", entityType: "admin_user", result: "failure", metadata: { reason: "email_in_use" } });
    return;
  }
  const now = new Date();
  try {
    await sequelize.transaction(async (t) => {
      const partner = await Partner.create({
        name, slug: slugify(name), kind: "reseller", status: "suspended", statusReason: SIGNUP_PENDING_REASON,
        startsAt: now, endsAt: new Date(Date.UTC(now.getUTCFullYear() + 10, now.getUTCMonth(), now.getUTCDate())),
        billingModel: "none", monthlyFeeCents: 0, suspendPolicy: "manual", // revendedor compra licenças: sem mensalidade
        contactName, contactEmail: mail, contactPhone: phone,
      }, { transaction: t });
      await AdminUser.create({ name: contactName, email: mail, passwordHash, role: "partner", partnerId: partner.id }, { transaction: t });
      await audit({ actor, action: "reseller.signup", entityType: "partner", entityId: partner.id, metadata: { name, email: mail }, transaction: t });
    });
  } catch (e) {
    if (!(e instanceof UniqueConstraintError)) throw e; // corrida: o mesmo e-mail chegou duas vezes ao mesmo tempo
  }
}
