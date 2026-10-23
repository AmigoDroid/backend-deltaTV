import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Partner, Invoice, Payment } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { competenceBounds, currentCompetence, dueDateFor, toDateOnly } from "../../shared/dates.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { calculateAmount } from "./billing.calc.js";
import { isDelinquent } from "../access/access.policy.js";
import { overdueSinceFor } from "../access/access.service.js";
import { AUTO_SUSPEND_REASON } from "../partners/partner.service.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";

const SYSTEM = { type: "system", id: null };

// Dispositivos cobráveis na competência: vinculados em algum momento do mês (inclui bloqueados).
export async function billableDeviceCount(partnerId, competence, transaction) {
  const { start, end } = competenceBounds(competence);
  const [rows] = await sequelize.query(
    `SELECT count(*)::int AS n FROM activations
      WHERE partner_id = :partnerId AND activated_at < :end
        AND (revoked_at IS NULL OR revoked_at >= :start)`,
    { replacements: { partnerId, start, end }, transaction },
  );
  return rows[0].n;
}

/** Gera a cobrança da competência. Idempotente: (parceiro, competência) é único. */
export async function generateInvoice(partnerId, competence, actor = SYSTEM) {
  const existing = await Invoice.findOne({ where: { partnerId, competence } });
  if (existing) return { invoice: existing, created: false };
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  const { start, end } = competenceBounds(competence);
  if (partner.startsAt >= end || partner.endsAt <= start) {
    throw new AppError(422, "OUT_OF_CONTRACT", "A competência está fora do período do contrato.");
  }
  const count = await billableDeviceCount(partnerId, competence);
  const { amountCents, breakdown } = calculateAmount(partner, count);
  try {
    const invoice = await Invoice.create({
      partnerId, competence, deviceCount: count, amountCents, dueDate: dueDateFor(competence, partner.dueDay), breakdown,
    });
    await audit({ actor, action: "invoice.generate", entityType: "invoice", entityId: invoice.id, metadata: { partnerId, competence, amountCents } });
    return { invoice, created: true };
  } catch (e) {
    if (e instanceof UniqueConstraintError) return { invoice: await Invoice.findOne({ where: { partnerId, competence } }), created: false };
    throw e;
  }
}

export async function generateForAll(competence = currentCompetence(), actor = SYSTEM) {
  const { start, end } = competenceBounds(competence);
  const partners = await Partner.findAll({
    where: { status: { [Op.in]: ["active", "suspended"] }, startsAt: { [Op.lt]: end }, endsAt: { [Op.gt]: start } },
  });
  let created = 0;
  for (const p of partners) {
    const r = await generateInvoice(p.id, competence, actor);
    if (r.created) created++;
  }
  return { competence, partners: partners.length, created };
}

export async function listInvoices({ status, partnerId, competence, page, pageSize }) {
  const where = {};
  if (status) where.status = status;
  if (partnerId) where.partnerId = partnerId;
  if (competence) where.competence = competence;
  const { rows, count } = await Invoice.findAndCountAll({
    where, include: [{ model: Partner, attributes: ["id", "name", "slug"] }, { model: Payment }],
    order: [["dueDate", "DESC"]], ...pageOf({ page, pageSize }), distinct: true,
  });
  return paged(rows, count, { page, pageSize });
}

export async function listPayments({ partnerId, page, pageSize }) {
  const include = [{ model: Invoice, required: !!partnerId, where: partnerId ? { partnerId } : undefined, include: [{ model: Partner, attributes: ["id", "name"] }] }];
  const { rows, count } = await Payment.findAndCountAll({ include, order: [["paidAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true });
  return paged(rows, count, { page, pageSize });
}

async function reactivateIfSettled(partnerId, actor, t) {
  const p = await Partner.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!p || p.status !== "suspended" || p.statusReason !== AUTO_SUSPEND_REASON) return false;
  const overdueSince = await overdueSinceFor(partnerId, t);
  if (isDelinquent(p, overdueSince)) return false;
  await p.update({ status: "active", statusReason: null }, { transaction: t });
  await audit({ actor, action: "partner.reactivate", entityType: "partner", entityId: partnerId, metadata: { auto: true, reason: "payment_confirmed" }, transaction: t });
  return true;
}

/**
 * Confirma pagamento. Só é chamado por (a) webhook autenticado ou (b) administrador autenticado e auditado —
 * nunca por informação vinda do frontend do parceiro/cliente.
 */
export async function confirmPayment(invoiceId, input, actor) {
  const result = await sequelize.transaction(async (t) => {
    const invoice = await Invoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!invoice) throw notFound("Fatura");
    if (invoice.status === "cancelled") throw new AppError(409, "INVOICE_CANCELLED", "Fatura cancelada.");
    const remaining = invoice.amountCents - invoice.paidCents;
    if (remaining <= 0) throw new AppError(409, "ALREADY_PAID", "Fatura já quitada.");
    if (input.amountCents > remaining) throw new AppError(422, "AMOUNT_EXCEEDS_BALANCE", "Valor maior que o saldo da fatura.");

    const payment = await Payment.create(
      {
        invoiceId, amountCents: input.amountCents, method: input.method ?? null,
        provider: input.provider ?? "manual", providerRef: input.providerRef ?? null,
        origin: input.origin, confirmedBy: input.origin === "admin" ? actor.id : null, note: input.note ?? null,
      },
      { transaction: t },
    );
    const paid = invoice.paidCents + input.amountCents;
    await invoice.update(
      { paidCents: paid, status: paid >= invoice.amountCents ? "paid" : "partial", paidAt: paid >= invoice.amountCents ? new Date() : null },
      { transaction: t },
    );
    const reactivated = await reactivateIfSettled(invoice.partnerId, actor, t);
    await audit({
      actor, action: "payment.confirm", entityType: "invoice", entityId: invoiceId,
      metadata: { paymentId: payment.id, amountCents: input.amountCents, origin: input.origin, provider: input.provider, reactivated }, transaction: t,
    });
    return { payment, invoice, reactivated };
  });
  if (result.reactivated) clearMirrorAuth();
  return result;
}

export async function cancelInvoice(id, { reason }, actor) {
  let reactivated = false;
  const inv = await sequelize.transaction(async (t) => {
    const inv = await Invoice.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inv) throw notFound("Fatura");
    if (inv.paidCents > 0) throw new AppError(409, "HAS_PAYMENTS", "Fatura com pagamentos não pode ser cancelada.");
    await inv.update({ status: "cancelled" }, { transaction: t });
    reactivated = await reactivateIfSettled(inv.partnerId, actor, t);
    await audit({ actor, action: "invoice.cancel", entityType: "invoice", entityId: id, metadata: { reason }, transaction: t });
    return inv;
  });
  if (reactivated) clearMirrorAuth();
  return inv;
}

/**
 * Política de inadimplência: marca faturas vencidas e suspende parcerias (política automática)
 * cujo atraso excede a tolerância. O bloqueio efetivo NÃO depende deste job: o gate de acesso
 * recalcula a inadimplência a cada requisição; o job apenas persiste o status para o painel.
 */
export async function sweepDelinquency(actor = SYSTEM) {
  const today = toDateOnly(new Date());
  const [marked] = await Invoice.update(
    { status: "overdue" },
    { where: { status: { [Op.in]: ["open", "partial"] }, dueDate: { [Op.lt]: today } } },
  );
  const partners = await Partner.findAll({ where: { status: "active", suspendPolicy: "auto_after_grace" } });
  const suspended = [];
  for (const p of partners) {
    const overdueSince = await overdueSinceFor(p.id);
    if (!isDelinquent(p, overdueSince)) continue;
    await sequelize.transaction(async (t) => {
      const fresh = await Partner.findByPk(p.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (fresh.status !== "active") return;
      await fresh.update({ status: "suspended", statusReason: AUTO_SUSPEND_REASON }, { transaction: t });
      await audit({ actor, action: "partner.suspend", entityType: "partner", entityId: p.id, metadata: { auto: true, overdueSince }, transaction: t });
      suspended.push(p.id);
    });
  }
  if (suspended.length) clearMirrorAuth();
  return { markedOverdue: marked, suspended };
}
