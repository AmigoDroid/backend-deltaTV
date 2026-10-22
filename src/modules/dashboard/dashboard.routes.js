import { Router } from "express";
import { Op } from "sequelize";
import { sequelize, License, Partner, Activation, Invoice, AuditLog } from "../../db/models/index.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { calculateAmount } from "../billing/billing.calc.js";
import { billableDeviceCount } from "../billing/billing.service.js";
import { currentCompetence, toDateOnly } from "../../shared/dates.js";
import { countUnlinkedDevices } from "../devices/unlinked.service.js";

const router = Router();
const day = 86400000;

router.get("/", requirePermission("dashboard:read"), async (_req, res) => {
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

  const pendingInvoices = await Invoice.findAll({ where: { status: { [Op.in]: ["open", "partial", "overdue"] } }, attributes: ["amountCents", "paidCents", "dueDate"] });
  const pending = {
    count: pendingInvoices.length,
    amountCents: pendingInvoices.reduce((s, i) => s + (i.amountCents - i.paidCents), 0),
    overdueCount: pendingInvoices.filter((i) => i.dueDate < today).length,
  };

  // Receita recorrente prevista: mensalidade calculada (modelo contratado) das parcerias ativas.
  const competence = currentCompetence(now);
  let mrrCents = 0;
  for (const p of await Partner.findAll({ where: { status: "active", endsAt: { [Op.gt]: now } } })) {
    try { mrrCents += calculateAmount(p, await billableDeviceCount(p.id, competence)).amountCents; } catch { /* contrato mal configurado: ignora no total */ }
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

  res.json({
    licenses: { active, expired, suspended, blocked },
    devices: { active: devicesActive, blocked: devicesBlocked, unlinked: devicesUnlinked },
    partners: { active: partnersActive, suspended: partnersSuspended },
    billing: { pending, mrrCents, receivedThisMonthCents: Number(paidRow.total) },
    recentActivations,
    alerts: { expiringLicenses, endingPartners, overdueInvoices: overdue },
    events,
  });
});

export default router;
