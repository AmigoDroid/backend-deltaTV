import { Op } from "sequelize";
import { Partner, AdminUser, Customer } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError, notFound } from "../../shared/errors.js";

export const AUDIENCES = ["resellers", "partners", "partner", "customers", "custom"];
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
export const isEmail = (s) => typeof s === "string" && s.length <= 200 && EMAIL_RE.test(s);

/**
 * Quem vai receber. Devolve { list: [{ email, name }], skipped, label }.
 *  - resellers / partners: parceiros ATIVOS. O e-mail é o de contato da parceria; sem ele, os usuários ativos do portal dela.
 *  - partner: uma parceria específica (qualquer status).
 *  - customers: clientes cadastrados com e-mail (tabela customers).
 *  - custom: a lista digitada pelo administrador (endereço inválido não derruba o envio: vai para `skipped`).
 * Duplicados (mesmo e-mail) são unidos. O teto MAIL_MAX_RECIPIENTS protege contra disparo gigante por engano.
 */
export async function resolveRecipients({ audience, partnerId, emails }) {
  let raw = [];
  let label = "";

  if (audience === "custom") {
    raw = (emails ?? []).map((e) => ({ email: e, name: "" }));
    label = "Lista de e-mails informada";
  } else if (audience === "customers") {
    const rows = await Customer.findAll({ where: { email: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }] } }, attributes: ["name", "email"] });
    raw = rows.map((c) => ({ email: c.email, name: c.name }));
    label = "Clientes com e-mail cadastrado";
  } else {
    const where = audience === "partner" ? { id: partnerId } : { status: "active", ...(audience === "resellers" ? { kind: "reseller" } : {}) };
    const partners = await Partner.findAll({ where, attributes: ["id", "name", "contactName", "contactEmail"] });
    if (audience === "partner" && !partners.length) throw notFound("Parceiro");
    const needUsers = partners.filter((p) => !p.contactEmail?.trim()).map((p) => p.id);
    const users = needUsers.length
      ? await AdminUser.findAll({ where: { partnerId: needUsers, role: "partner", status: "active" }, attributes: ["partnerId", "name", "email"] })
      : [];
    for (const p of partners) {
      const contact = p.contactEmail?.trim();
      if (contact) raw.push({ email: contact, name: p.contactName || p.name });
      else for (const u of users.filter((x) => x.partnerId === p.id)) raw.push({ email: u.email, name: u.name || p.name });
    }
    label = audience === "partner" ? `Parceiro: ${partners[0].name}` : audience === "resellers" ? "Todas as revendas ativas" : "Todos os parceiros ativos";
  }

  const seen = new Set();
  const list = [];
  let skipped = 0;
  for (const r of raw) {
    const email = String(r.email ?? "").trim();
    const key = email.toLowerCase();
    if (!isEmail(email)) { skipped += 1; continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ email, name: String(r.name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 160) });
  }
  if (list.length > env.mail.maxRecipients) {
    throw new AppError(422, "TOO_MANY_RECIPIENTS", `Público grande demais (${list.length}). O limite por envio é ${env.mail.maxRecipients}; divida em grupos.`);
  }
  return { list, skipped, label };
}
