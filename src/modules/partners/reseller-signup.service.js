import { consumeInvite } from "../distribution/network.service.js";
import { INVITED_RESELLER_RESTRICTED_RESOURCES, invitedSignupState } from "../distribution/invite-onboarding.policy.js";
import crypto from "node:crypto";
import { UniqueConstraintError } from "sequelize";
import { sequelize, Partner, AdminUser } from "../../db/models/index.js";
import { audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { AppError } from "../../shared/errors.js";

/**
 * Autocadastro de revendedor (tela pública do portal do revendedor).
 *
 * Cadastro normal (sem convite) permanece aguardando aprovação do administrador.
 * Com convite validado e consumido em transação, a conta entra ATIVA na rede do Master.
 * Recursos de maior privilégio permanecem desativados por padrão até concessão do Master.
 * Não adiciona colunas ou tabelas: usa a estrutura da Rede de Masters já migrada.
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
export async function registerReseller({ name: companyName, contactName, email, phone, password, inviteToken }, meta) {
  // O cadastro público pede só o nome da pessoa. O nome do parceiro (e o identificador interno/slug, que nunca é
  // digitado) nascem dele; o admin pode ajustar depois. `name` continua aceito por compatibilidade com clientes antigos.
  const name = companyName?.trim() || contactName;
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
      const parentPartnerId = inviteToken ? await consumeInvite(inviteToken, t) : null;
      const signupState = invitedSignupState(Boolean(parentPartnerId));
      const partner = await Partner.create({
        name, slug: slugify(name), kind: "reseller", parentPartnerId, distributionRole: "reseller", ...signupState,
        startsAt: now, endsAt: new Date(Date.UTC(now.getUTCFullYear() + 10, now.getUTCMonth(), now.getUTCDate())),
        billingModel: "none", monthlyFeeCents: 0, suspendPolicy: "manual", // revendedor compra licenças: sem mensalidade
        contactName, contactEmail: mail, contactPhone: phone,
      }, { transaction: t });
      // Uma URL de convite é uma credencial de ingresso, não uma autorização irrestrita.
      // O Master pode conceder esses recursos depois, obedecendo suas próprias permissões.
      if (parentPartnerId) {
        for (const resource of INVITED_RESELLER_RESTRICTED_RESOURCES) {
          await sequelize.query(`INSERT INTO reseller_network_resources(partner_id,resource,enabled,limit_value)
            VALUES(:partnerId,:resource,false,NULL)`,{
            replacements:{partnerId:partner.id,resource},transaction:t,
          });
        }
      }
      await AdminUser.create({ name: contactName, email: mail, passwordHash, role: "partner", partnerId: partner.id }, { transaction: t });
      await audit({ actor, action: "reseller.signup", entityType: "partner", entityId: partner.id,
        metadata: { name, email: mail, parentPartnerId, autoActivatedByInvite:Boolean(parentPartnerId) }, transaction: t });
    });
  } catch (e) {
    if (!(e instanceof UniqueConstraintError)) throw e; // corrida: o mesmo e-mail chegou duas vezes ao mesmo tempo
  }
}
