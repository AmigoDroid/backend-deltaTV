import { Partner, ResellerClient } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { macHex } from "../../shared/mac.js";
import { paged } from "../../shared/pagination.js";
import { sql } from "../stock/stock-ledger.js";
import { TODAY } from "./client.sql.js";
import { DUE_SOON_DAYS, cleanText } from "./client.rules.js";
import { MAX_CLIENTS_PER_PARTNER, createClient, deleteClient, duplicate, fieldsFrom, listClients, rowView, summary } from "./client.service.js";

/**
 * Clientes das revendas visto pelo ADMIN: sem o isolamento por revendedor do portal. O admin enxerga as fichas de todas as
 * revendas, cria/edita/apaga em nome de qualquer uma e pode mover uma ficha para outra revenda. Toda escrita é auditada com
 * o admin como autor (actor) e o partnerId da ficha. Continua valendo: a ficha é só cadastro; não mexe em dispositivo/licença.
 */
const escLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

async function assertPartner(partnerId) {
  const p = await Partner.findByPk(partnerId);
  if (!p) throw new AppError(422, "INVALID_PARTNER", "Revenda inexistente.");
  return p;
}

const withPartner = (r) => ({ ...rowView(r), partnerId: r.partner_id, partnerName: r.partner_name });

/** Lista global (todas as revendas). Com partnerId, devolve a lista unificada da revenda (fichas + TVs ativadas sem ficha). */
export async function adminList({ partnerId, q, filter = "all", page, pageSize }) {
  if (partnerId) {
    const [partner, res] = await Promise.all([assertPartner(partnerId), listClients({ partnerId, q, filter, page, pageSize })]);
    return { ...res, data: res.data.map((c) => ({ ...c, partnerId, partnerName: partner.name })) };
  }
  const text = cleanText(q) ?? null;
  const hex = macHex(text);
  const digits = String(text ?? "").replace(/\D/g, "");
  const macLike = !!text && /^[0-9a-f:.\-\s]+$/i.test(text) && hex.length >= 4;
  const conds = [];
  if (text) {
    conds.push("c.name ILIKE :like", "c.address ILIKE :like", "c.phone ILIKE :like", "p.name ILIKE :like");
    if (digits.length >= 4) conds.push("regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE :digits");
    if (macLike) conds.push("replace(c.mac, ':', '') LIKE :hex");
  }
  const byFilter = {
    all: "TRUE", unregistered: "FALSE", // sem revenda escolhida só existem fichas; "sem ficha" depende de uma revenda
    overdue: `c.due_date < ${TODAY}`,
    due_soon: `c.due_date >= ${TODAY} AND c.due_date <= ${TODAY} + ${DUE_SOON_DAYS}`,
    no_due: "c.due_date IS NULL",
  };
  const from = `
    FROM reseller_clients c
    JOIN partners p ON p.id = c.partner_id
    LEFT JOIN LATERAL (
      SELECT a.id, a.status, a.activated_at, a.granted_license_id FROM activations a
       WHERE a.partner_id = c.partner_id AND a.mac = c.mac AND a.status <> 'revoked'
       ORDER BY a.activated_at DESC LIMIT 1
    ) act ON TRUE
    LEFT JOIN licenses l ON l.id = act.granted_license_id
    WHERE ${byFilter[filter] ?? "TRUE"} ${text ? `AND (${conds.join(" OR ")})` : ""}`;
  const replacements = {
    limit: pageSize, offset: (page - 1) * pageSize,
    ...(text ? { like: `%${escLike(text)}%` } : {}), ...(digits.length >= 4 && text ? { digits: `%${digits}%` } : {}), ...(macLike ? { hex: `%${hex}%` } : {}),
  };
  const [rows, count] = await Promise.all([
    sql(`SELECT c.id AS client_id, c.partner_id, p.name AS partner_name, c.mac, c.name, c.phone, c.address, c.price_cents, c.notes,
                to_char(c.due_date, 'YYYY-MM-DD') AS due_date, (c.due_date - ${TODAY}) AS days_left,
                act.id AS activation_id, act.status AS activation_status, act.activated_at,
                l.status AS license_status, l.expires_at AS license_expires_at
         ${from}
         ORDER BY p.name ASC, (c.due_date IS NULL), c.due_date ASC, c.name ASC
         LIMIT :limit OFFSET :offset`, replacements),
    sql(`SELECT count(*)::int AS total ${from}`, replacements),
  ]);
  return paged(rows.map(withPartner), Number(count[0]?.total ?? 0), { page, pageSize });
}

export async function adminSummary(partnerId) {
  if (partnerId) return summary(partnerId);
  const [r] = await sql(
    `SELECT count(*)::int AS clients,
            count(*) FILTER (WHERE due_date < ${TODAY})::int AS overdue,
            count(*) FILTER (WHERE due_date >= ${TODAY} AND due_date <= ${TODAY} + ${DUE_SOON_DAYS})::int AS due_soon,
            COALESCE(sum(price_cents), 0)::bigint AS monthly_cents
       FROM reseller_clients`,
    {},
  );
  return { clients: Number(r.clients), overdue: Number(r.overdue), dueSoon: Number(r.due_soon), dueSoonDays: DUE_SOON_DAYS, monthlyCents: Number(r.monthly_cents) };
}

export async function adminCreate({ actor, input: { partnerId, ...input } }) {
  await assertPartner(partnerId);
  return createClient({ partnerId, actor, input });
}

/** Edita qualquer ficha. `partnerId` no corpo move a ficha para outra revenda (o MAC não pode já ter ficha lá). */
export async function adminUpdate({ id, actor, input: { partnerId: toPartnerId, ...input } }) {
  const c = await ResellerClient.findByPk(id);
  if (!c) throw notFound("Cliente");
  const fields = fieldsFrom(input, { create: false });
  const moving = toPartnerId && toPartnerId !== c.partnerId;
  if (moving) {
    await assertPartner(toPartnerId);
    if ((await ResellerClient.count({ where: { partnerId: toPartnerId } })) >= MAX_CLIENTS_PER_PARTNER) {
      throw new AppError(422, "CLIENT_LIMIT", `Limite de ${MAX_CLIENTS_PER_PARTNER} clientes cadastrados na revenda de destino atingido.`);
    }
    fields.partnerId = toPartnerId;
  }
  const fromPartnerId = c.partnerId;
  try {
    await c.update(fields);
  } catch (e) {
    if (e?.name === "SequelizeUniqueConstraintError") throw duplicate();
    throw e;
  }
  await audit({
    actor, action: "client.update", entityType: "reseller_client", entityId: id,
    metadata: { mac: c.mac.trim(), partnerId: c.partnerId, fields: Object.keys(fields), ...(moving ? { movedFrom: fromPartnerId } : {}) },
  });
  return { id: c.id };
}

export async function adminDelete({ id, actor }) {
  const c = await ResellerClient.findByPk(id);
  if (!c) throw notFound("Cliente");
  await deleteClient({ partnerId: c.partnerId, id, actor });
}
