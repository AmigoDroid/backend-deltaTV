import { macHex } from "../../shared/mac.js";
import { cleanText, DUE_SOON_DAYS, FILTERS } from "./client.rules.js";

/**
 * SQL da lista unificada de clientes (função pura: devolve texto + parâmetros nomeados, sem tocar no banco).
 * Valores NUNCA são concatenados no texto: tudo que vem do usuário vai em `replacements`.
 */
export const TODAY = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;

const FILTER_SQL = {
  all: "TRUE",
  overdue: `c.due_date < ${TODAY}`,
  due_soon: `c.due_date >= ${TODAY} AND c.due_date <= ${TODAY} + ${DUE_SOON_DAYS}`,
  no_due: "c.id IS NOT NULL AND c.due_date IS NULL",
  unregistered: "c.id IS NULL",
};

const escLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function buildListSql({ partnerId, q, filter = "all", limit, offset }) {
  if (!FILTERS.includes(filter)) throw new Error("filtro inválido");
  const text = cleanText(q) ?? null;
  const hex = macHex(text);
  const digits = String(text ?? "").replace(/\D/g, "");
  // Só trata a busca como MAC quando ela PARECE um MAC (senão "Ana" casaria com todo MAC que tenha A).
  const macLike = !!text && /^[0-9a-f:.\-\s]+$/i.test(text) && hex.length >= 4;
  const phoneLike = digits.length >= 4;

  const conds = [];
  if (text) {
    conds.push("c.name ILIKE :like", "c.address ILIKE :like", "c.phone ILIKE :like");
    if (phoneLike) conds.push("regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE :digits");
    if (macLike) conds.push("replace(k.mac, ':', '') LIKE :hex");
  }
  const search = text ? `AND (${conds.join(" OR ")})` : "";

  const from = `
    FROM keys k
    LEFT JOIN reseller_clients c ON c.partner_id = :p AND c.mac = k.mac
    LEFT JOIN act ON act.mac = k.mac
    LEFT JOIN licenses l ON l.id = act.granted_license_id
    WHERE ${FILTER_SQL[filter]} ${search}`;
  const cte = `
    WITH keys AS (
      SELECT mac FROM reseller_clients WHERE partner_id = :p
      UNION
      SELECT mac FROM activations WHERE partner_id = :p AND status <> 'revoked' AND mac IS NOT NULL
    ), act AS (
      SELECT DISTINCT ON (mac) id, mac, status, activated_at, granted_license_id
        FROM activations WHERE partner_id = :p AND status <> 'revoked' AND mac IS NOT NULL
       ORDER BY mac, activated_at DESC
    )`;
  return {
    countSql: `${cte} SELECT count(*)::int AS total ${from}`,
    rowsSql: `${cte}
      SELECT k.mac, c.id AS client_id, c.name, c.phone, c.address, c.price_cents, c.notes,
             to_char(c.due_date, 'YYYY-MM-DD') AS due_date, (c.due_date - ${TODAY}) AS days_left,
             act.id AS activation_id, act.status AS activation_status, act.activated_at,
             l.status AS license_status, l.expires_at AS license_expires_at
      ${from}
      ORDER BY (c.due_date IS NULL), c.due_date ASC, c.name ASC NULLS LAST, k.mac ASC
      LIMIT :limit OFFSET :offset`,
    replacements: {
      p: partnerId, limit, offset,
      ...(text ? { like: `%${escLike(text)}%` } : {}), ...(phoneLike ? { digits: `%${digits}%` } : {}), ...(macLike ? { hex: `%${hex}%` } : {}),
    },
  };
}
