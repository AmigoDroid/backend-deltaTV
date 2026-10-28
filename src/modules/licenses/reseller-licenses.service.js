import { QueryTypes } from "sequelize";
import { sequelize, License, Plan, Activation, Device, Renewal, LicenseEvent } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { addLicenseMonthsUTC } from "../../shared/dates.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { effectiveLicenseStatus, evaluateAccess } from "../access/access.policy.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { ensurePlan } from "./plan.service.js";
import { balancesOf, move } from "../stock/stock-ledger.js";

/**
 * Licenças do revendedor (portal): as que ele É DONO (licenses.owner_partner_id = ele), nascidas do estoque dele,
 * seja por "Aplicar a este MAC" ou pelo código de ativação. O partnerId vem SEMPRE do token; licença de outro dono
 * (ou da plataforma) responde 404, igual a inexistente.
 *
 * O que o revendedor pode fazer: ver, RENOVAR gastando uma licença do estoque, e SUSPENDER/REATIVAR as suas.
 * O que continua só com a plataforma: bloquear, cancelar e reativar licença bloqueada/cancelada/suspensa pela plataforma.
 */

/** Marca de uma suspensão feita pelo revendedor: só ela pode ser desfeita por ele (a da plataforma não). */
export const RESELLER_SUSPENSION = "Suspensa pelo revendedor";

export const LICENSE_FILTERS = ["all", "active", "expiring", "expired", "suspended", "blocked", "cancelled", "pending", "unused"];
const EXPIRING_DAYS = 7;
const DAY = 86_400_000;

const FILTER_SQL = {
  all: "TRUE",
  active: "l.status = 'active' AND l.expires_at > now()",
  expiring: `l.status = 'active' AND l.expires_at > now() AND l.expires_at <= now() + interval '${EXPIRING_DAYS} days'`,
  expired: "l.status = 'active' AND l.expires_at <= now()",
  suspended: "l.status = 'suspended'",
  blocked: "l.status = 'blocked'",
  cancelled: "l.status = 'cancelled'",
  pending: "l.status = 'pending'",
  unused: "a.id IS NULL", // sem aparelho vinculado
};

const escLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const remainingDays = (expiresAt, now = new Date()) =>
  expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY)) : null;

const LICENSE_FROM = `
  FROM licenses l
  JOIN plans p ON p.id = l.plan_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.mac, x.status, (x.granted_license_id IS NOT NULL) AS granted
      FROM activations x
     WHERE (x.license_id = l.id OR x.granted_license_id = l.id) AND x.status <> 'revoked'
     ORDER BY x.activated_at DESC LIMIT 1
  ) a ON TRUE
  LEFT JOIN reseller_clients c ON c.partner_id = :p AND c.mac = a.mac`;

function mapRow(r) {
  const license = { status: r.status, expiresAt: r.expires_at };
  return {
    id: r.id, status: r.status, effectiveStatus: effectiveLicenseStatus(license),
    statusReason: r.status === "active" ? null : r.status_reason,
    months: r.duration_months, codeLast4: r.code_last4,
    startsAt: r.starts_at, expiresAt: r.expires_at, remainingDays: remainingDays(r.expires_at),
    createdAt: r.created_at,
    device: r.mac ? { activationId: r.activation_id, mac: r.mac, status: r.activation_status } : null,
    client: r.client_id ? { id: r.client_id, name: r.client_name, phone: r.client_phone } : null,
    ...capabilities(license, r.status_reason),
  };
}

/** O que a tela pode oferecer (o servidor revalida em cada ação). */
function capabilities(license, statusReason) {
  return {
    canRenew: !["cancelled", "blocked"].includes(license.status),
    canSuspend: license.status === "active",
    canReactivate: license.status === "suspended" && statusReason === RESELLER_SUSPENSION,
  };
}

export async function listOwned({ partnerId, q, filter = "all", page, pageSize }) {
  if (!LICENSE_FILTERS.includes(filter)) throw new AppError(400, "INVALID_FILTER", "Filtro inválido.");
  const text = String(q ?? "").trim().slice(0, 60);
  const hex = text.replace(/[^0-9a-f]/gi, "").toUpperCase();
  const macLike = !!text && /^[0-9a-f:.\-\s]+$/i.test(text) && hex.length >= 4;
  const conds = [];
  if (text) {
    conds.push("c.name ILIKE :like", "c.phone ILIKE :like", "l.code_last4 = :last4");
    if (macLike) conds.push("replace(a.mac, ':', '') LIKE :hex");
  }
  const where = `WHERE l.owner_partner_id = :p AND (${FILTER_SQL[filter]})${text ? ` AND (${conds.join(" OR ")})` : ""}`;
  const replacements = {
    p: partnerId, ...pageOf({ page, pageSize }),
    ...(text ? { like: `%${escLike(text)}%`, last4: text.toUpperCase() } : {}), ...(macLike ? { hex: `%${hex}%` } : {}),
  };
  const [{ total }] = await sequelize.query(`SELECT count(*)::int AS total ${LICENSE_FROM} ${where}`, { replacements, type: QueryTypes.SELECT });
  const rows = await sequelize.query(
    `SELECT l.id, l.status, l.status_reason, l.starts_at, l.expires_at, l.created_at, l.code_last4, p.duration_months,
            a.id AS activation_id, a.mac, a.status AS activation_status, c.id AS client_id, c.name AS client_name, c.phone AS client_phone
     ${LICENSE_FROM} ${where}
     ORDER BY (l.expires_at IS NULL), l.expires_at ASC, l.id ASC
     LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT },
  );
  return paged(rows.map(mapRow), total, { page, pageSize });
}

export async function summaryOf(partnerId) {
  const [r] = await sequelize.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS active,
            count(*) FILTER (WHERE status = 'active' AND expires_at > now() AND expires_at <= now() + interval '${EXPIRING_DAYS} days')::int AS expiring,
            count(*) FILTER (WHERE status = 'active' AND expires_at <= now())::int AS expired,
            count(*) FILTER (WHERE status IN ('suspended','blocked'))::int AS suspended
       FROM licenses WHERE owner_partner_id = :p`,
    { replacements: { p: partnerId }, type: QueryTypes.SELECT },
  );
  return { ...r, expiringDays: EXPIRING_DAYS };
}

async function loadOwned(partnerId, id, options = {}) {
  const l = await License.findOne({ where: { id, ownerPartnerId: partnerId }, ...options });
  if (!l) throw notFound("Licença");
  return l;
}

export async function getOwned({ partnerId, id }) {
  const l = await loadOwned(partnerId, id, {
    include: [
      { model: Plan, attributes: ["id", "name", "durationMonths"] },
      { model: Activation, include: [{ model: Device, attributes: ["platform", "appVersion", "lastSeenAt"] }], required: false },
      { model: Activation, as: "GrantedActivations", include: [{ model: Device, attributes: ["platform", "appVersion", "lastSeenAt"] }], required: false },
      { model: Renewal, include: [{ model: Plan, attributes: ["durationMonths"] }], required: false },
    ],
    order: [[Renewal, "createdAt", "DESC"]],
  });
  const j = l.toJSON();
  const now = new Date();
  const seen = new Map();
  for (const a of [...(j.Activations ?? []), ...(j.GrantedActivations ?? [])]) seen.set(a.id, a);
  const devices = [...seen.values()]
    .sort((x, y) => new Date(y.activatedAt) - new Date(x.activatedAt))
    .map((a) => {
      const d = evaluateAccess({ activation: a, license: l });
      return {
        activationId: a.id, mac: a.mac, status: a.status, activatedAt: a.activatedAt, revokedAt: a.revokedAt, statusReason: a.status === "revoked" ? a.statusReason : null,
        platform: a.Device?.platform ?? null, appVersion: a.Device?.appVersion ?? null, lastSeenAt: a.Device?.lastSeenAt ?? null,
        access: { allowed: d.allowed, message: d.message },
        // Só a licença vendida pelo código (ativação de parceria) pode ir para outro MAC (rota /licenses/transfer).
        transferable: a.status === "active" && a.partnerId === partnerId && a.grantedLicenseId === l.id,
      };
    });
  const events = await LicenseEvent.findAll({ where: { licenseId: l.id, partnerId }, order: [["createdAt", "DESC"]], limit: 50 });
  return {
    id: l.id, status: l.status, effectiveStatus: effectiveLicenseStatus(l), statusReason: l.status === "active" ? null : l.statusReason,
    months: j.Plan?.durationMonths ?? null, codeLast4: l.codeLast4,
    startsAt: l.startsAt, expiresAt: l.expiresAt, remainingDays: remainingDays(l.expiresAt, now), createdAt: l.createdAt,
    ...capabilities(l, l.statusReason),
    devices,
    renewals: (j.Renewals ?? []).map((r) => ({ id: r.id, at: r.createdAt, months: r.Plan?.durationMonths ?? null, from: r.previousExpiresAt, to: r.newExpiresAt })),
    events: events.map((e) => ({ id: e.id, at: e.createdAt, event: e.event, actorType: e.actorType, metadata: { reason: e.metadata?.reason ?? null, fromMac: e.metadata?.fromMac ?? null, toMac: e.metadata?.toMac ?? null, months: e.metadata?.months ?? null } })),
  };
}

/** Renova gastando 1 licença do estoque (mesma regra de prazo do admin: soma ao saldo se ainda vale; senão conta de agora). */
export async function renewOwned({ partner, actor, id, months }) {
  const result = await sequelize.transaction(async (t) => {
    const lock = { transaction: t, lock: t.LOCK.UPDATE };
    const l = await loadOwned(partner.id, id, lock);
    if (["cancelled", "blocked"].includes(l.status)) {
      throw new AppError(409, "NOT_RENEWABLE", "Esta licença está cancelada ou bloqueada. Fale com a plataforma.");
    }
    const plan = await ensurePlan(months, { transaction: t });
    const now = new Date();
    const previous = l.expiresAt;
    const base = l.expiresAt && l.expiresAt > now ? l.expiresAt : now;
    const expiresAt = addLicenseMonthsUTC(base, months);
    await l.update({ planId: plan.id, expiresAt, startsAt: l.startsAt ?? now, status: l.status === "pending" ? "active" : l.status }, { transaction: t });
    await Renewal.create({ licenseId: l.id, planId: plan.id, previousExpiresAt: previous, newExpiresAt: expiresAt, createdBy: actor?.id ?? null }, { transaction: t });
    await move(t, { partnerId: partner.id, months, delta: -1, kind: "consume", actor, licenseId: l.id, note: "Renovação" });
    await audit({ actor, action: "license.renew", entityType: "license", entityId: l.id, metadata: { months, from: previous, to: expiresAt, by: "reseller" }, transaction: t });
    return { id: l.id, months, expiresAt };
  });
  clearMirrorAuth(); // o vencimento mudou: o espelho não pode seguir negando pelo cache
  return { ...result, balances: await balancesOf(partner.id) };
}

/** Suspende (acesso cortado em todos os aparelhos da licença). O prazo continua correndo, como na suspensão da plataforma. */
export async function suspendOwned({ partner, actor, id, reason }) {
  await sequelize.transaction(async (t) => {
    const l = await loadOwned(partner.id, id, { transaction: t, lock: t.LOCK.UPDATE });
    if (l.status !== "active") throw new AppError(409, "INVALID_STATE", `Não é possível suspender uma licença '${effectiveLicenseStatus(l)}'.`);
    await l.update({ status: "suspended", statusReason: RESELLER_SUSPENSION }, { transaction: t });
    await LicenseEvent.create({ licenseId: l.id, partnerId: partner.id, event: "suspended", actorType: actor?.type ?? "partner", actorId: actor?.id ?? null, metadata: { reason: reason ?? null } }, { transaction: t });
    await audit({ actor, action: "license.suspend", entityType: "license", entityId: l.id, metadata: { from: "active", to: "suspended", reason, by: "reseller" }, transaction: t });
  });
  clearMirrorAuth();
}

/** Reativa SÓ uma suspensão feita pelo próprio revendedor. */
export async function reactivateOwned({ partner, actor, id }) {
  await sequelize.transaction(async (t) => {
    const l = await loadOwned(partner.id, id, { transaction: t, lock: t.LOCK.UPDATE });
    if (l.status !== "suspended") throw new AppError(409, "INVALID_STATE", "Esta licença não está suspensa.");
    if (l.statusReason !== RESELLER_SUSPENSION) throw new AppError(403, "SUSPENDED_BY_PLATFORM", "Esta licença foi suspensa pela plataforma. Fale com ela para reativar.");
    const to = l.startsAt ? "active" : "pending"; // nunca iniciou: volta como pendente (mesma regra do admin)
    await l.update({ status: to, statusReason: null }, { transaction: t });
    await LicenseEvent.create({ licenseId: l.id, partnerId: partner.id, event: "reactivated", actorType: actor?.type ?? "partner", actorId: actor?.id ?? null, metadata: {} }, { transaction: t });
    await audit({ actor, action: "license.reactivate", entityType: "license", entityId: l.id, metadata: { from: "suspended", to, by: "reseller" }, transaction: t });
  });
  clearMirrorAuth();
}
