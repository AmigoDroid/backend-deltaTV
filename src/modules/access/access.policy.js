import { daysBetween, toDateOnly } from "../../shared/dates.js";

/**
 * ÚNICA fonte de verdade para "este dispositivo pode acessar agora?".
 * Função pura: recebe o estado carregado do banco e devolve a decisão.
 * Bloqueios/expirações são DERIVADOS do estado atual, por isso valem na próxima requisição
 * e a reativação devolve o acesso aos dispositivos elegíveis sem reativar um a um.
 */
export const DENIAL_MESSAGES = {
  ACTIVATION_NOT_FOUND: "Dispositivo não ativado.",
  ACTIVATION_REVOKED: "Ativação removida.",
  DEVICE_BLOCKED: "Dispositivo bloqueado.",
  LICENSE_BLOCKED: "Licença bloqueada.",
  LICENSE_SUSPENDED: "Licença suspensa.",
  LICENSE_CANCELLED: "Licença cancelada.",
  LICENSE_NOT_STARTED: "Licença ainda não iniciada.",
  LICENSE_EXPIRED: "Licença expirada.",
  PARTNER_BLOCKED: "Serviço indisponível. Contate seu fornecedor.",
  PARTNER_SUSPENDED: "Serviço indisponível. Contate seu fornecedor.",
  PARTNER_CANCELLED: "Serviço indisponível. Contate seu fornecedor.",
  PARTNER_NOT_STARTED: "Serviço indisponível. Contate seu fornecedor.",
  PARTNER_EXPIRED: "Serviço indisponível. Contate seu fornecedor.",
  PARTNER_DELINQUENT: "Serviço indisponível. Contate seu fornecedor.",
  NO_LICENSE: "Dispositivo sem licença associada.",
};

const deny = (code, reason = null) => ({
  allowed: false,
  code,
  message: DENIAL_MESSAGES[code] ?? "Acesso negado.",
  reason,
  expiresAt: null,
});

/**
 * @param {object} p
 * @param {object} p.activation { status, statusReason }
 * @param {object|null} p.license { status, startsAt, expiresAt }
 * @param {object|null} p.grantedLicense licença concedida a uma ativação de PARCERIA a partir do estoque do revendedor.
 *   O prazo é o da licença (conta desde a venda, não desde o pagamento da mensalidade do portal). Do cadastro do
 *   revendedor só derrubam o cliente o bloqueio e o cancelamento; vigência/inadimplência do portal não.
 * @param {object|null} p.partner { status, startsAt, endsAt, suspendPolicy, graceDays }
 * @param {string|null} p.overdueSince "YYYY-MM-DD" da fatura vencida mais antiga ainda não paga
 */
export function evaluateAccess({ activation, license = null, grantedLicense = null, partner = null, now = new Date(), overdueSince = null }) {
  if (!activation) return deny("ACTIVATION_NOT_FOUND");
  if (activation.status === "revoked") return deny("ACTIVATION_REVOKED");
  if (activation.status === "blocked") return deny("DEVICE_BLOCKED", activation.statusReason);

  if (license) return evaluateLicense(license, now);

  if (grantedLicense) {
    if (partner?.status === "blocked") return deny("PARTNER_BLOCKED", partner.statusReason);
    if (partner?.status === "cancelled") return deny("PARTNER_CANCELLED", partner.statusReason);
    return evaluateLicense(grantedLicense, now);
  }

  if (partner) {
    if (partner.status === "blocked") return deny("PARTNER_BLOCKED", partner.statusReason);
    if (partner.status === "suspended") return deny("PARTNER_SUSPENDED", partner.statusReason);
    if (partner.status === "cancelled") return deny("PARTNER_CANCELLED", partner.statusReason);
    if (new Date(partner.startsAt) > now) return deny("PARTNER_NOT_STARTED");
    if (new Date(partner.endsAt) <= now) return deny("PARTNER_EXPIRED");
    if (isDelinquent(partner, overdueSince, now)) return deny("PARTNER_DELINQUENT");
    return { allowed: true, code: "OK", message: "Acesso autorizado.", reason: null, expiresAt: new Date(partner.endsAt) };
  }

  return deny("NO_LICENSE");
}

function evaluateLicense(license, now) {
  if (license.status === "blocked") return deny("LICENSE_BLOCKED", license.statusReason);
  if (license.status === "suspended") return deny("LICENSE_SUSPENDED", license.statusReason);
  if (license.status === "cancelled") return deny("LICENSE_CANCELLED", license.statusReason);
  if (license.status === "pending" || !license.startsAt || new Date(license.startsAt) > now) {
    return deny("LICENSE_NOT_STARTED");
  }
  if (new Date(license.expiresAt) <= now) return deny("LICENSE_EXPIRED");
  return { allowed: true, code: "OK", message: "Acesso autorizado.", reason: null, expiresAt: new Date(license.expiresAt) };
}

// Inadimplente = fatura vencida há mais dias que a tolerância (grace_days), com política automática.
export function isDelinquent(partner, overdueSince, now = new Date()) {
  if (!overdueSince || partner.suspendPolicy !== "auto_after_grace") return false;
  return daysBetween(overdueSince, toDateOnly(now)) > Number(partner.graceDays ?? 0);
}

// Status "efetivo" para exibição no painel (expirada é derivada da data).
export function effectiveLicenseStatus(license, now = new Date()) {
  if (license.status === "active" && license.expiresAt && new Date(license.expiresAt) <= now) return "expired";
  return license.status;
}

export function effectivePartnerStatus(partner, now = new Date()) {
  if (partner.status === "active" && new Date(partner.endsAt) <= now) return "expired";
  return partner.status;
}
