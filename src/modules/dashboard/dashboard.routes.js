import { Router } from "express";
import { Op, QueryTypes } from "sequelize";
import { sequelize, License, Partner, Activation, Invoice, AuditLog } from "../../db/models/index.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { calculateAmount } from "../billing/billing.calc.js";
import { currentCompetence, competenceBounds, toDateOnly } from "../../shared/dates.js";
import { countUnlinkedDevices } from "../devices/unlinked.service.js";

const router = Router();
const day = 86400000;
let snapshot = null;
let snapshotUntil = 0;
let pendingSnapshot = null;
export function invalidateDashboardCache() { snapshot = null; snapshotUntil = 0; }


router.get("/", requirePermission("dashboard:read"), async (_req, res) => {
  const data = await loadDashboard();
  res.set("Cache-Control", "no-store").json(data);
});
async function loadDashboard() {
  if (snapshot && snapshotUntil > Date.now()) return snapshot;
  if (pendingSnapshot) return pendingSnapshot;
  pendingSnapshot = computeDashboard().then(data => {
    snapshot = data; snapshotUntil = Date.now() + 12000;
    return data;
  }).finally(() => { pendingSnapshot = null; });
  return pendingSnapshot;
}
async function computeDashboard() {
  const now = new Date();
  const today = toDateOnly(now);
  const soon = new Date(now.getTime() + 7 * day);
  const [active, expired, suspended, blocked, devicesActive, devicesBlocked, devicesUnlinked, partnersActive, partnersSuspended] = await Promise.all([
    License.count({ where: { status: "active", expiresAt: { [Op.gt]: now } } }),
    License.count({ where: { status: "active", expiresAt: { [Op.lte]: now } } }),
    License.count({ where: { status: "suspended" } }),
    License.count({ where: { status: "blocked" } }),
    Activation.count({ where: { status: "active" } }),
    Activation.count({ where: { status: "blocked" } }),
    countUnlinkedDevices(),
    Partner.count({ where: { status: "active" } }),
    Partner.count({ where: { status: { [Op.in]: ["suspended", "blocked"] } } }),
  ]);

  // Agregação no PostgreSQL: não materializar cada fatura em memória.
  const [invoiceSummary] = await sequelize.query(`
    SELECT count(*)::integer AS count,
      COALESCE(sum(GREATEST(amount_cents - paid_cents, 0)),0)::bigint AS "amountCents",
      count(*) FILTER (WHERE due_date < :today)::integer AS "overdueCount"
    FROM invoices WHERE status IN ('open','partial','overdue')`,
    { replacements: { today } });
  const pending = { count: Number(invoiceSummary[0]?.count || 0),
    amountCents: Number(invoiceSummary[0]?.amountCents || 0), overdueCount: Number(invoiceSummary[0]?.overdueCount || 0) };

  // Uma agregação por competência, mesmo com milhares de parceiros. Evita N+1.
  const competence = currentCompetence(now);
  const { start, end } = competenceBounds(competence);
  const billablePartners = await Partner.findAll({ where: { status: "active", endsAt: { [Op.gt]: now } }, raw: true });
  const billableIds = billablePartners.filter(p => p.billingModel !== "none" && p.billingModel !== "fixed").map(p => p.id);
  let counts = new Map();
  if (billableIds.length) {
    const [usage] = await sequelize.query(`
      SELECT partner_id AS id, count(*)::integer AS n FROM activations
      WHERE partner_id IN (:ids) AND activated_at < :end
        AND (revoked_at IS NULL OR revoked_at >= :start)
      GROUP BY partner_id`, { replacements: { ids: billableIds, start, end } });
    counts = new Map(usage.map(row => [String(row.id), Number(row.n)]));
  }
  let mrrCents = 0;
  for (const p of billablePartners) {
    try { mrrCents += calculateAmount(p, counts.get(String(p.id)) || 0).amountCents; }
    catch { /* Contrato mal configurado: não travar painel. */ }
  }
  // Separação dos tipos e estados no SQL, antes de qualquer paginação.
  const breakdownRows = await sequelize.query(`
    SELECT kind, status, status_reason AS reason, count(*)::integer AS n FROM partners
    WHERE status <> 'deleted' GROUP BY kind, status, status_reason`,
    { type: QueryTypes.SELECT });
  const partnerBreakdown = { content: { active: 0, inactive: 0 }, reseller: { active: 0, inactive: 0 }, pendingSignups: 0 };
  for (const row of breakdownRows) {
    const types = row.kind === "both" ? ["content", "reseller"] : [row.kind];
    for (const type of types) {
      if (!partnerBreakdown[type]) continue;
      partnerBreakdown[type][row.status === "active" ? "active" : "inactive"] += Number(row.n);
    }
    if (["reseller", "both"].includes(row.kind) && row.status === "suspended" &&
        row.reason === "Aguardando aprovação do cadastro") partnerBreakdown.pendingSignups += Number(row.n);
  }

  const [paidRow] = (await sequelize.query(
    `SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM payments
      WHERE status='confirmed' AND paid_at >= date_trunc('month', now() AT TIME ZONE 'UTC')`,
  ))[0];

  const [recentActivations, expiringLicenses, endingPartners, overdue, events] = await Promise.all([
    Activation.findAll({ order: [["activatedAt", "DESC"]], limit: 8, attributes: ["id", "mac", "status", "activatedAt", "licenseId", "partnerId"] }),
    License.findAll({ where: { status: "active", expiresAt: { [Op.between]: [now, soon] } }, order: [["expiresAt", "ASC"]], limit: 10, attributes: ["id", "codeLast4", "expiresAt"] }),
    Partner.findAll({ where: { status: "active", endsAt: { [Op.between]: [now, new Date(now.getTime() + 15 * day)] } }, order: [["endsAt", "ASC"]], limit: 10, attributes: ["id", "name", "endsAt"] }),
    Invoice.findAll({ where: { status: { [Op.in]: ["open", "partial", "overdue"] }, dueDate: { [Op.lt]: today } }, include: [{ model: Partner, attributes: ["id", "name"] }], order: [["dueDate", "ASC"]], limit: 10 }),
    AuditLog.findAll({ where: { action: { [Op.regexp]: "\\.(block|unblock|suspend|reactivate|revoke|cancel)$" } }, order: [["createdAt", "DESC"]], limit: 10 }),
  ]);

  return {
    licenses: { active, expired, suspended, blocked },
    devices: { active: devicesActive, blocked: devicesBlocked, unlinked: devicesUnlinked },
    partners: { active: partnersActive, suspended: partnersSuspended },
    partnerBreakdown,
    billing: { pending, mrrCents, receivedThisMonthCents: Number(paidRow.total) },
    recentActivations,
    alerts: { expiringLicenses, endingPartners, overdueInvoices: overdue },
    events,
  };
}

export default router;
