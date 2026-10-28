import { Op, UniqueConstraintError } from "sequelize";
import { ResellerClient, Activation, PartnerProvider } from "../../db/models/index.js";
import { decryptSecret } from "../../shared/crypto.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { normalizeMac } from "../../shared/mac.js";
import { paged } from "../../shared/pagination.js";
import { sql } from "../stock/stock-ledger.js";
import { buildListSql, TODAY } from "./client.sql.js";
import { DUE_SOON_DAYS, cleanText, parseDueDate, parsePhone } from "./client.rules.js";

/**
 * Clientes do revendedor, por MAC. ISOLAMENTO: toda consulta e escrita filtra por partnerId vindo do TOKEN; ficha de outro
 * revendedor => 404. A ficha é só cadastro do revendedor: não altera dispositivo, ativação nem licença.
 * A auditoria registra QUEM mexeu e QUAIS campos, mas não grava telefone/endereço (dado pessoal do cliente final).
 */
export const MAX_CLIENTS_PER_PARTNER = 10_000;
const invalid = (message) => new AppError(422, "VALIDATION_ERROR", message);

/** Linha do SQL da lista -> JSON da API. `device` = TV ativada por este revendedor (null = só cadastrada à mão). */
export function rowView(r) {
  const expires = r.license_expires_at ? new Date(r.license_expires_at) : null;
  return {
    mac: String(r.mac).trim(), clientId: r.client_id ?? null,
    name: r.name ?? null, phone: r.phone ?? null, address: r.address ?? null, notes: r.notes ?? null,
    priceCents: r.price_cents ?? null, dueDate: r.due_date ?? null, daysLeft: r.days_left == null ? null : Number(r.days_left),
    device: r.activation_status ? {
      activationId: r.activation_id, status: r.activation_status, activatedAt: r.activated_at,
      licenseStatus: r.license_status ?? null, licenseExpiresAt: expires,
    } : null,
  };
}

export async function listClients({ partnerId, q, filter = "all", page, pageSize }) {
  const query = buildListSql({ partnerId, q, filter, limit: pageSize, offset: (page - 1) * pageSize });
  const [rows, count] = await Promise.all([sql(query.rowsSql, query.replacements), sql(query.countSql, query.replacements)]);
  return paged(rows.map(rowView), Number(count[0]?.total ?? 0), { page, pageSize });
}

/** Cartões do topo: só fichas cadastradas (a receita prevista soma o valor mensal cobrado de cada cliente). */
export async function summary(partnerId) {
  const [r] = await sql(
    `SELECT count(*)::int AS clients,
            count(*) FILTER (WHERE due_date < ${TODAY})::int AS overdue,
            count(*) FILTER (WHERE due_date >= ${TODAY} AND due_date <= ${TODAY} + ${DUE_SOON_DAYS})::int AS due_soon,
            COALESCE(sum(price_cents), 0)::bigint AS monthly_cents
       FROM reseller_clients WHERE partner_id = :partnerId`,
    { partnerId },
  );
  return { clients: Number(r.clients), overdue: Number(r.overdue), dueSoon: Number(r.due_soon), dueSoonDays: DUE_SOON_DAYS, monthlyCents: Number(r.monthly_cents) };
}

/** Valida/normaliza os campos enviados. Só devolve as chaves que vieram (PATCH parcial); `create` exige nome e MAC. */
export function fieldsFrom(input, { create }) {
  const out = {};
  if (input.mac !== undefined || create) {
    const mac = normalizeMac(input.mac);
    if (!mac) throw invalid("MAC inválido. Use o formato AA:BB:CC:DD:EE:FF.");
    out.mac = mac;
  }
  if (input.name !== undefined || create) {
    const name = cleanText(input.name);
    if (!name || name.length < 2) throw invalid("Informe o nome do cliente (mínimo 2 letras).");
    if (name.length > 160) throw invalid("Nome muito longo (máximo 160 caracteres).");
    out.name = name;
  }
  const phone = parsePhone(input.phone);
  if (phone.error) throw invalid(phone.error);
  if (phone.value !== undefined) out.phone = phone.value;
  const due = parseDueDate(input.dueDate);
  if (due.error) throw invalid(due.error);
  if (due.value !== undefined) out.dueDate = due.value;
  for (const [key, max, label] of [["address", 300, "Endereço"], ["notes", 500, "Observações"]]) {
    const v = cleanText(input[key]);
    if (v && v.length > max) throw invalid(`${label} muito longo (máximo ${max} caracteres).`);
    if (v !== undefined) out[key] = v;
  }
  if (input.priceCents !== undefined) {
    const p = input.priceCents;
    if (p !== null && (!Number.isInteger(p) || p < 0 || p > 100_000_000)) throw invalid("Valor inválido.");
    out.priceCents = p;
  }
  return out;
}

export const duplicate = () => new AppError(409, "CLIENT_EXISTS", "Já existe um cliente cadastrado com este MAC. Edite o cadastro existente.");

export async function createClient({ partnerId, actor, input }) {
  const fields = fieldsFrom(input, { create: true });
  if ((await ResellerClient.count({ where: { partnerId } })) >= MAX_CLIENTS_PER_PARTNER) {
    throw new AppError(422, "CLIENT_LIMIT", `Limite de ${MAX_CLIENTS_PER_PARTNER} clientes cadastrados atingido.`);
  }
  let c;
  try {
    c = await ResellerClient.create({ partnerId, ...fields });
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw duplicate();
    throw e;
  }
  await audit({ actor, action: "client.create", entityType: "reseller_client", entityId: c.id, metadata: { mac: fields.mac, partnerId } });
  return { id: c.id };
}

export async function updateClient({ partnerId, id, actor, input }) {
  const fields = fieldsFrom(input, { create: false });
  const c = await ResellerClient.findOne({ where: { id, partnerId } }); // ficha de outro revendedor => 404
  if (!c) throw notFound("Cliente");
  try {
    await c.update(fields);
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw duplicate(); // trocou o MAC para um que já tem ficha
    throw e;
  }
  await audit({ actor, action: "client.update", entityType: "reseller_client", entityId: id, metadata: { mac: c.mac.trim(), partnerId, fields: Object.keys(fields) } });
  return { id: c.id };
}

/** Apaga só a ficha. Dispositivo, ativação e licença continuam como estão. */
export async function deleteClient({ partnerId, id, actor }) {
  const c = await ResellerClient.findOne({ where: { id, partnerId } });
  if (!c) throw notFound("Cliente");
  await c.destroy();
  await audit({ actor, action: "client.delete", entityType: "reseller_client", entityId: id, metadata: { mac: c.mac.trim(), partnerId } });
}

/**
 * Usuário e senha da lista que o cliente digitou na TV, para o revendedor atender sem depender da plataforma.
 * - Só ativações DESTE revendedor e ainda vivas (partnerId vem do token; de outro revendedor => 404).
 * - Sob demanda, nunca dentro da lista de clientes: cada consulta é auditada (quem, qual TV e quando).
 * - A auditoria NÃO grava usuário nem senha. Resposta com Cache-Control: no-store (ver rota).
 */
export async function credentialsOf({ partnerId, activationId, actor }) {
  const a = await Activation.findOne({
    where: { id: activationId, partnerId, status: { [Op.ne]: "revoked" } },
    include: [{ model: PartnerProvider, attributes: ["name"], required: false }],
  });
  if (!a) throw notFound("Ativação");
  if (!a.credentialsEnc) {
    throw new AppError(404, "NO_CREDENTIALS", "Esta TV não tem usuário e senha de lista guardados (as credenciais foram removidas).");
  }
  let creds;
  try { creds = JSON.parse(decryptSecret(a.credentialsEnc)); } catch {
    throw new AppError(500, "CREDENTIALS_UNREADABLE", "Não foi possível ler as credenciais desta TV.");
  }
  await audit({ actor, action: "client.credentials.view", entityType: "activation", entityId: a.id, metadata: { mac: a.mac } });
  return { mac: a.mac, server: a.PartnerProvider?.name ?? null, username: creds.username ?? "", password: creds.password ?? "" };
}
