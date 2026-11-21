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
import { SIGNUP_PENDING_REASON } from "../partners/reseller-signup.service.js";

const SYSTEM = { type: "system", id: null };

// A competência só é fechada após seu último dia em UTC; nunca faturar o mês em andamento
// em uma execução horária do scheduler.
export function nextCompetence(competence) {
  const { end } = competenceBounds(competence);
  return currentCompetence(end);
}

export function lastClosedCompetence(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return currentCompetence(previous);
}

/** Competências encerradas a reprocessar, da mais antiga à mais recente. */
export function recoveryCompetences(now = new Date(), lookbackMonths = 12) {
  const count = Number(lookbackMonths);
  if (!Number.isInteger(count) || count < 1 || count > 60)
    throw new RangeError("BILLING_RECOVERY_MONTHS deve estar entre 1 e 60.");
  return Array.from({ length: count }, (_, index) => {
    const monthsBack = count - index;
    return currentCompetence(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1)));
  });
}

/**
 * Reprocessa janelas encerradas: a chave única parceiro/competência evita
 * cobrança duplicada, e generateInvoice não altera uma fatura paga/cancelada.
 * Erros de um mês não impedem os demais; a próxima execução tenta novamente.
 */
export async function recoverMissedInvoices({ now = new Date(), months = 6, graceDays = 7, actor = SYSTEM } = {}) {
  const results = [];
  for (const competence of recoveryCompetences(now, months)) {
    try {
      results.push({ ...(await generateForAll(competence, actor, { recoveryGraceDays: graceDays })), ok: true });
    } catch (error) {
      results.push({ competence, ok: false, error: error?.message || "Falha ao gerar faturas" });
    }
  }
  return { created: results.reduce((sum, item) => sum + (item.created || 0), 0),
    failed: results.filter((item) => !item.ok).length, results };
}


// Dispositivos cobráveis na competência: vinculados em algum momento do mês (inclui bloqueados).
export async function billableDeviceCount(partnerId, competence, transaction) {
  const { start, end } = competenceBounds(competence);
  const [rows] = await sequelize.query(
    `SELECT count(DISTINCT device_id)::int AS n FROM activations
      WHERE partner_id = :partnerId AND activated_at < :end
        AND (revoked_at IS NULL OR revoked_at >= :start)`,
    { replacements: { partnerId, start, end }, transaction },
  );
  return rows[0].n;
}

/** Gera a cobrança da competência. Idempotente: (parceiro, competência) é único. */
export async function generateInvoice(partnerId, competence, actor = SYSTEM, { recoveryGraceDays = 0 } = {}) {
  if (competence >= currentCompetence()) throw new AppError(422, "COMPETENCE_NOT_CLOSED", "A competência ainda não terminou.");
  const existing = await Invoice.findOne({ where: { partnerId, competence } });
  if (existing) {
    if (existing.status === "cancelled") return { invoice: existing, created: false, skipped: "CANCELLED_REQUIRES_REOPEN" };
    // Faturas legadas emitidas antes do fechamento podem ter contagem incompleta.
    // Nunca sobrescrever uma fatura que já recebeu pagamento ou foi revisada manualmente.
    if (existing.paidCents === 0 && !existing.breakdown?.revised && !existing.breakdown?.closed) {
      const partner = await Partner.findByPk(partnerId);
      const count = await billableDeviceCount(partnerId, competence);
      const { amountCents, breakdown } = calculateAmount(partner, count);
      if (amountCents > 0) {
        const previous = { amountCents: existing.amountCents, deviceCount: existing.deviceCount };
        await sequelize.transaction(async (t) => {
          const locked = await Invoice.findByPk(existing.id, { transaction: t, lock: t.LOCK.UPDATE });
          if (locked.paidCents !== 0 || locked.status === "cancelled" || locked.breakdown?.closed || locked.breakdown?.revised) return;
          await locked.update({ amountCents, deviceCount: count, breakdown: { ...breakdown, closed: true } }, { transaction: t });
          await audit({ actor, action: "invoice.close", entityType: "invoice", entityId: locked.id,
            metadata: { competence, previous, amountCents, count }, transaction: t });
        });
        await existing.reload();
      }
    }
    return { invoice: existing, created: false };
  }
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  const { start, end } = competenceBounds(competence);
  if (partner.startsAt >= end || partner.endsAt <= start) {
    throw new AppError(422, "OUT_OF_CONTRACT", "A competência está fora do período do contrato.");
  }
  // Sem mensalidade (modelo "none") ou valor zero: não existe cobrança a fazer. Nunca se gera fatura de R$ 0,00.
  if (partner.billingModel === "none") return { invoice: null, created: false, skipped: "NO_BILLING" };
  const count = await billableDeviceCount(partnerId, competence);
  const { amountCents, breakdown } = calculateAmount(partner, count);
  if (amountCents <= 0) return { invoice: null, created: false, skipped: "ZERO_AMOUNT" };
  try {
    const scheduledDueDate = dueDateFor(nextCompetence(competence), partner.dueDay);
    // Em recuperação, não suspender imediatamente um parceiro por cobrança que
    // o próprio sistema deixou de emitir. Dar prazo explícito para quitação.
    const late = recoveryGraceDays > 0 && scheduledDueDate < toDateOnly(new Date());
    const dueDate = late
      ? toDateOnly(new Date(Date.now() + Math.min(60, Math.max(1, recoveryGraceDays)) * 86_400_000))
      : scheduledDueDate;
    const invoice = await Invoice.create({
      partnerId, competence, deviceCount: count, amountCents, dueDate,
      breakdown: { ...breakdown, closed: true, ...(late ? { recoveredLate: true, scheduledDueDate } : {}) },
    });
    await audit({ actor, action: "invoice.generate", entityType: "invoice", entityId: invoice.id, metadata: { partnerId, competence, amountCents } });
    return { invoice, created: true };
  } catch (e) {
    if (e instanceof UniqueConstraintError) return { invoice: await Invoice.findOne({ where: { partnerId, competence } }), created: false };
    throw e;
  }
}

export async function generateForAll(competence = lastClosedCompetence(), actor = SYSTEM, options = {}) {
  if (competence >= currentCompetence()) {
    throw new AppError(422, "COMPETENCE_NOT_CLOSED", "A competência ainda não terminou. Gere apenas competências encerradas.");
  }
  const { start, end } = competenceBounds(competence);
  const partners = await Partner.findAll({
    where: {
      status: { [Op.in]: ["active", "suspended"] }, billingModel: { [Op.ne]: "none" }, startsAt: { [Op.lt]: end }, endsAt: { [Op.gt]: start },
      // Cadastro público ainda não aprovado não gera cobrança.
      [Op.or]: [{ statusReason: null }, { statusReason: { [Op.ne]: SIGNUP_PENDING_REASON } }],
    },
  });
  let created = 0;
  for (const p of partners) {
    const r = await generateInvoice(p.id, competence, actor, options);
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
export async function confirmPaymentTx(t, invoiceId, input, actor) {
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
}

/** Versão autônoma (abre a própria transação). O Pix usa confirmPaymentTx para entregar tudo na MESMA transação. */
export async function confirmPayment(invoiceId, input, actor) {
  const result = await sequelize.transaction((t) => confirmPaymentTx(t, invoiceId, input, actor));
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

/** Reabre fatura cancelada SEM excluir o documento original nem perder sua referência. */
export async function reopenInvoice(id, { reason }, actor) {
  return sequelize.transaction(async (t) => {
    const invoice = await Invoice.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!invoice) throw notFound("Fatura");
    if (invoice.status !== "cancelled" || invoice.paidCents !== 0) throw new AppError(409, "INVALID_STATE", "Só faturas canceladas e sem pagamento podem ser reabertas.");
    if (invoice.competence >= currentCompetence()) throw new AppError(422, "COMPETENCE_NOT_CLOSED", "A competência não foi encerrada.");
    await invoice.update({ status: invoice.dueDate < toDateOnly(new Date()) ? "overdue" : "open" }, { transaction: t });
    await audit({ actor, action: "invoice.reopen", entityType: "invoice", entityId: id, metadata: { reason, competence: invoice.competence }, transaction: t });
    return invoice;
  });
}

/** Retificação controlada: nunca altera fatura quitada nem apaga o valor anterior do log. */
export async function reviseInvoice(id, { amountCents, dueDate, reason }, actor) {
  let reactivated = false;
  const invoice = await sequelize.transaction(async (t) => {
    const inv = await Invoice.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inv) throw notFound("Fatura");
    if (inv.status === "cancelled") throw new AppError(409, "INVOICE_CANCELLED", "Reabra a fatura antes de revisá-la.");
    if (inv.paidCents > 0) throw new AppError(409, "HAS_PAYMENTS", "Fatura com pagamentos não pode ter valor ou vencimento alterados diretamente.");
    if (inv.competence >= currentCompetence()) throw new AppError(422, "COMPETENCE_NOT_CLOSED", "A competência não foi encerrada.");
    const before = { amountCents: inv.amountCents, dueDate: inv.dueDate, status: inv.status, breakdown: inv.breakdown };
    const newAmount = amountCents ?? inv.amountCents;
    const newDue = dueDate ?? inv.dueDate;
    await inv.update({ amountCents: newAmount, dueDate: newDue, status: newDue < toDateOnly(new Date()) ? "overdue" : "open",
      breakdown: { ...inv.breakdown, revised: true } }, { transaction: t });
    reactivated = await reactivateIfSettled(inv.partnerId, actor, t);
    await audit({ actor, action: "invoice.revise", entityType: "invoice", entityId: id,
      metadata: { reason, before, after: { amountCents: newAmount, dueDate: newDue }, reactivated }, transaction: t });
    return inv;
  });
  if (reactivated) clearMirrorAuth();
  return invoice;
}

/** Estorno administrativo contabilizado, sem apagar a linha de recebimento. */
export async function refundPaymentTx(t, paymentId, { reason, providerConfirmed = false }, actor) {
  // Bloquear a fatura primeiro mantém a mesma ordem de lock adotada na confirmação de pagamento.
  const located = await Payment.findByPk(paymentId, { transaction: t });
  if (!located) throw notFound("Pagamento");
  if (!located.invoiceId) throw new AppError(422, "NOT_INVOICE_PAYMENT", "Pagamento não vinculado a fatura.");
  const invoice = await Invoice.findByPk(located.invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
  const payment = await Payment.findByPk(paymentId, { transaction: t, lock: t.LOCK.UPDATE });
  if (payment.status === "refunded") return { invoice, payment, already: true };
  if (payment.status !== "confirmed") throw new AppError(409, "INVALID_STATE", "Este pagamento não pode ser estornado.");
  if (payment.provider !== "manual" && !providerConfirmed) {
    throw new AppError(409, "PROVIDER_CONFIRMATION_REQUIRED", "Confirme o estorno no provedor antes de contabilizá-lo.");
  }
  await payment.update({ status: "refunded", note: [payment.note, `Estorno: ${reason}`].filter(Boolean).join(" | ").slice(0, 500) }, { transaction: t });
  const outstanding = await Payment.sum("amountCents", { where: { invoiceId: invoice.id, status: "confirmed" }, transaction: t });
  const paidCents = Number(outstanding || 0);
  const status = paidCents >= invoice.amountCents ? "paid" : paidCents > 0 ? "partial" : invoice.dueDate < toDateOnly(new Date()) ? "overdue" : "open";
  await invoice.update({ paidCents, status, paidAt: status === "paid" ? invoice.paidAt : null }, { transaction: t });
  await audit({ actor, action: "payment.refund", entityType: "invoice", entityId: invoice.id,
    metadata: { paymentId, amountCents: payment.amountCents, reason, providerConfirmed, paidCents }, transaction: t });
  return { invoice, payment, already: false };
}

export async function refundManualPayment(paymentId, input, actor) {
  const result = await sequelize.transaction(async (t) => refundPaymentTx(t, paymentId, input, actor));
  return result;
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
      // A leitura anterior foi apenas um filtro; o pagamento pode ter entrado entre as duas leituras.
      const currentOverdue = await overdueSinceFor(p.id, t);
      if (!isDelinquent(fresh, currentOverdue)) return;
      await fresh.update({ status: "suspended", statusReason: AUTO_SUSPEND_REASON }, { transaction: t });
      await audit({ actor, action: "partner.suspend", entityType: "partner", entityId: p.id, metadata: { auto: true, overdueSince: currentOverdue }, transaction: t });
      suspended.push(p.id);
    });
  }
  // Repara suspensões automáticas que ficaram sem dívida após uma confirmação concorrente.
  const autoSuspended = await Partner.findAll({ where: { status: "suspended", statusReason: AUTO_SUSPEND_REASON } });
  const reactivated = [];
  for (const p of autoSuspended) {
    const changed = await sequelize.transaction(async (t) => {
      const fresh = await Partner.findByPk(p.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (fresh.status !== "suspended" || fresh.statusReason !== AUTO_SUSPEND_REASON) return false;
      const overdue = await overdueSinceFor(p.id, t);
      if (isDelinquent(fresh, overdue)) return false;
      await fresh.update({ status: "active", statusReason: null }, { transaction: t });
      await audit({ actor, action: "partner.reactivate", entityType: "partner", entityId: p.id,
        metadata: { auto: true, reason: "no_outstanding_delinquency" }, transaction: t });
      return true;
    });
    if (changed) reactivated.push(p.id);
  }
  if (suspended.length || reactivated.length) clearMirrorAuth();
  return { markedOverdue: marked, suspended, reactivated };
}
