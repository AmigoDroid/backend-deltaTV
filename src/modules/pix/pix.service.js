import { Op } from "sequelize";
import { sequelize, Partner, Invoice, PixCharge } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { getProvider, pixEnabled } from "./providers/index.js";
import { confirmPaymentTx } from "../billing/billing.service.js";
import { STOCK_KINDS, move } from "../stock/stock-ledger.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { priceOf } from "./pix.pricing.js";

/**
 * Cobranças Pix.
 *
 * Regra de ouro: o QUE foi comprado e QUANTO custa é decidido aqui, no servidor (fatura do banco / tabela de preços).
 * O front só escolhe "qual fatura" ou "quantas licenças de quantos meses". E quem confirma o pagamento é sempre o
 * provedor: a notificação (webhook) só diz "olhe o pagamento N"; o servidor consulta o pagamento direto na API do
 * provedor e confere (a) que a referência externa é desta cobrança e (b) que o valor pago é exatamente o cobrado.
 *
 * Entrega (fulfil) é atômica e idempotente: cobrança travada FOR UPDATE; a fatura é quitada (ou as licenças entram no
 * estoque) e a cobrança vira "paid" na MESMA transação. Reentrega de webhook, polling do front e conciliação do job
 * podem chegar juntos: só um entrega.
 *
 * Se o dinheiro chegou mas a entrega não é possível (valor diferente, fatura já quitada/cancelada à mão, cadastro
 * bloqueado) a cobrança vai para "review" com o motivo e aparece no painel admin — nada é entregue "no escuro".
 */
const SYSTEM = { type: "system", id: null, name: "Pix" };
const REUSE_MIN_REMAINING_MS = 3 * 60_000; // só reaproveita um QR pendente que ainda valha mais que isto
const CHECK_INTERVAL_MS = 4_000; // no máximo uma consulta ao provedor a cada 4 s por cobrança (polling do front)
const MAX_PENDING_PER_PARTNER = 10;
export const MAX_STOCK_QUANTITY = 1000;
const MAX_CHARGE_CENTS = 10_000_000; // R$ 100.000,00 por Pix
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { pixEnabled };

/* ---------- Apresentação ---------- */

const withRefs = [
  { model: Invoice, attributes: ["id", "competence"], required: false },
];

export function chargeView(c, { admin = false } = {}) {
  const pending = c.status === "pending";
  const j = {
    id: c.id, purpose: c.purpose, status: c.status, amountCents: c.amountCents,
    months: c.months, quantity: c.quantity, unitPriceCents: c.unitPriceCents,
    invoice: c.Invoice ? { id: c.Invoice.id, competence: c.Invoice.competence } : null,
    // O QR só é útil enquanto aguarda pagamento.
    qrCode: pending ? c.qrCode : null, qrCodeBase64: pending ? c.qrCodeBase64 : null,
    expiresAt: c.expiresAt, paidAt: c.paidAt, createdAt: c.createdAt,
  };
  if (!admin) return j;
  return {
    ...j, partner: c.Partner ? { id: c.Partner.id, name: c.Partner.name } : null, provider: c.provider, providerRef: c.providerRef,
    paidAmountCents: c.paidAmountCents, fulfilledAt: c.fulfilledAt, error: c.error,
  };
}

/* ---------- Criação ---------- */

function assertCanPay(partner) {
  if (["cancelled", "blocked"].includes(partner.status)) {
    throw new AppError(409, "INVALID_STATE", "Este cadastro não pode fazer pagamentos. Fale com a plataforma.");
  }
}

// Em desenvolvimento (localhost) o provedor não consegue chamar o webhook; sem URL pública o front confirma por consulta.
function webhookUrlFor(providerName) {
  const u = new URL(env.publicBaseUrl);
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname)) return undefined;
  return `${env.publicBaseUrl}/api/v1/webhooks/pix/${providerName}`;
}
export const webhookUrl = () => (env.pixProvider === "mercadopago" ? webhookUrlFor("mercadopago") : undefined);

async function openCharge({ provider, partner, user, actor, fields, reuseWhere, description }) {
  const now = new Date();
  const reusable = await PixCharge.findOne({
    where: {
      partnerId: partner.id, status: "pending", provider: provider.name, providerRef: { [Op.ne]: null },
      expiresAt: { [Op.gt]: new Date(now.getTime() + REUSE_MIN_REMAINING_MS) }, amountCents: fields.amountCents, ...reuseWhere,
    },
    include: withRefs, order: [["createdAt", "DESC"]],
  });
  if (reusable) return reusable; // duplo clique / reabrir a tela: mesmo QR, sem cobrança duplicada

  const pending = await PixCharge.count({ where: { partnerId: partner.id, status: "pending", expiresAt: { [Op.gt]: now } } });
  if (pending >= MAX_PENDING_PER_PARTNER) {
    throw new AppError(429, "TOO_MANY_PENDING", "Você já tem vários Pix aguardando pagamento. Pague ou espere expirarem antes de gerar outro.");
  }
  const email = user?.email || partner.contactEmail;
  if (!email) throw new AppError(422, "PAYER_EMAIL_REQUIRED", "O cadastro não tem e-mail. Informe um e-mail de contato à plataforma.");

  const expiresAt = new Date(now.getTime() + env.pixExpirationMinutes * 60_000);
  const charge = await PixCharge.create({
    partnerId: partner.id, provider: provider.name, status: "pending", expiresAt, createdBy: user?.id ?? null, ...fields,
  });
  try {
    const r = await provider.createCharge({
      id: charge.id, amountCents: fields.amountCents, description, expiresAt,
      payer: { email, name: user?.name ?? partner.name }, notificationUrl: webhookUrlFor(provider.name),
    });
    await charge.update({ providerRef: r.providerRef, qrCode: r.qrCode, qrCodeBase64: r.qrCodeBase64, ticketUrl: r.ticketUrl, expiresAt: r.expiresAt ?? expiresAt });
  } catch (e) {
    await charge.update({ status: "failed", error: String(e.message).slice(0, 500) }).catch(() => {});
    throw e;
  }
  await audit({
    actor, action: "pix.create", entityType: "pix_charge", entityId: charge.id,
    metadata: { purpose: fields.purpose, amountCents: fields.amountCents, invoiceId: fields.invoiceId, months: fields.months, quantity: fields.quantity },
  });
  return reload(charge.id);
}

/** Mensalidade (parceiro de conteúdo ou qualquer parceiro com fatura): cobra o SALDO da fatura. */
export async function createInvoiceCharge({ partner, user, actor, invoiceId }) {
  const provider = getProvider();
  assertCanPay(partner);
  const invoice = await Invoice.findOne({ where: { id: invoiceId, partnerId: partner.id } }); // outro parceiro => 404
  if (!invoice) throw notFound("Fatura");
  const remaining = invoice.amountCents - invoice.paidCents;
  if (["paid", "cancelled"].includes(invoice.status) || remaining <= 0) throw new AppError(409, "INVOICE_CLOSED", "Esta fatura não está em aberto.");
  return openCharge({
    provider, partner, user, actor, description: `Mensalidade ${invoice.competence} - ${partner.name}`,
    fields: { purpose: "invoice", invoiceId: invoice.id, amountCents: remaining },
    reuseWhere: { purpose: "invoice", invoiceId: invoice.id },
  });
}

/** Compra de licenças para o estoque do revendedor. O preço vem da tabela de preços, nunca do cliente. */
export async function createStockCharge({ partner, user, actor, months, quantity }) {
  const provider = getProvider();
  assertCanPay(partner);
  if (!STOCK_KINDS.includes(partner.kind)) throw new AppError(422, "NOT_A_RESELLER", "Só revendedores compram licenças para estoque.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_STOCK_QUANTITY) {
    throw new AppError(422, "INVALID_QUANTITY", `Informe de 1 a ${MAX_STOCK_QUANTITY} licenças.`);
  }
  const unitPriceCents = await priceOf(partner.id, months);
  const amountCents = unitPriceCents * quantity;
  if (amountCents > MAX_CHARGE_CENTS) throw new AppError(422, "AMOUNT_TOO_HIGH", "Valor acima do limite por Pix. Faça em mais de uma compra.");
  const label = `${quantity} licença(s) de ${months} ${months === 1 ? "mês" : "meses"}`;
  return openCharge({
    provider, partner, user, actor, description: `${label} - ${partner.name}`,
    fields: { purpose: "stock", months, quantity, unitPriceCents, amountCents },
    reuseWhere: { purpose: "stock", months, quantity, unitPriceCents },
  });
}

/* ---------- Estado e entrega ---------- */

// O provedor da cobrança precisa ser o que está configurado agora (trocar PIX_PROVIDER não pode confundir cobranças antigas).
const providerFor = (name) => {
  if (!pixEnabled()) return null;
  const p = getProvider();
  return p.name === name ? p : null;
};

function reload(id) {
  return PixCharge.findByPk(id, { include: [...withRefs, { model: Partner, attributes: ["id", "name"] }] });
}

async function expireIfDue(charge) {
  if (charge && charge.status === "pending" && new Date(charge.expiresAt) <= new Date()) {
    await PixCharge.update({ status: "expired" }, { where: { id: charge.id, status: "pending" } });
    return reload(charge.id);
  }
  return charge;
}

/** Entrega o que foi comprado, de forma atômica e idempotente. `info` = pagamento já consultado no provedor. */
async function fulfil(chargeId, info, actor) {
  let outcome;
  try {
    outcome = await sequelize.transaction(async (t) => {
      const c = await PixCharge.findByPk(chargeId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!c) throw notFound("Cobrança");
      if (c.status === "paid" || c.status === "refunded") return { already: true, reactivated: false };
      if (info.amountCents !== c.amountCents) {
        throw new AppError(422, "AMOUNT_MISMATCH", `Valor pago (${info.amountCents} centavos) diferente do cobrado (${c.amountCents}).`);
      }
      const now = new Date();
      let paymentId = null;
      let reactivated = false;

      if (c.purpose === "invoice") {
        const r = await confirmPaymentTx(t, c.invoiceId, {
          amountCents: info.amountCents, method: "pix", provider: c.provider, providerRef: info.providerRef, origin: "webhook",
          note: `Pix ${c.id.slice(0, 8)}`,
        }, { ...actor, type: actor.type ?? "system" });
        paymentId = r.payment.id;
        reactivated = r.reactivated;
      } else {
        const partner = await Partner.findByPk(c.partnerId, { transaction: t });
        if (!partner || !STOCK_KINDS.includes(partner.kind) || ["cancelled", "blocked"].includes(partner.status)) {
          throw new AppError(409, "INVALID_STATE", "O cadastro não pode receber licenças no estado atual.");
        }
        await ensurePlan(c.months, { transaction: t });
        const balance = await move(t, {
          partnerId: c.partnerId, months: c.months, delta: c.quantity, kind: "grant", actor: { id: null, name: "Pix" },
          unitPriceCents: c.unitPriceCents, note: `Compra via Pix (${c.id.slice(0, 8)})`,
        });
        await audit({
          actor, action: "stock.grant", entityType: "partner", entityId: c.partnerId,
          metadata: { source: "pix", chargeId: c.id, months: c.months, quantity: c.quantity, unitPriceCents: c.unitPriceCents, balance }, transaction: t,
        });
      }
      await c.update({
        status: "paid", paidAt: info.paidAt ?? now, paidAmountCents: info.amountCents, fulfilledAt: now, paymentId, error: null,
      }, { transaction: t });
      await audit({
        actor, action: "pix.paid", entityType: "pix_charge", entityId: c.id,
        metadata: { purpose: c.purpose, partnerId: c.partnerId, amountCents: c.amountCents, invoiceId: c.invoiceId, months: c.months, quantity: c.quantity }, transaction: t,
      });
      return { already: false, reactivated };
    });
  } catch (e) {
    if (e instanceof AppError && e.status < 500) {
      // Dinheiro recebido, entrega impossível: fica para revisão do admin (nunca se perde, nunca entrega errado).
      await PixCharge.update(
        { status: "review", paidAt: info.paidAt ?? new Date(), paidAmountCents: info.amountCents, error: `${e.code}: ${e.message}`.slice(0, 500) },
        { where: { id: chargeId, status: { [Op.in]: ["pending", "expired", "cancelled", "failed", "review"] } } },
      );
      await audit({ actor, action: "pix.review", entityType: "pix_charge", entityId: chargeId, result: "failure", metadata: { code: e.code, amountCents: info.amountCents } });
      return reload(chargeId);
    }
    throw e;
  }
  if (outcome.reactivated) clearMirrorAuth(); // parceria reativada pelo pagamento: o espelho não pode seguir negando pelo cache
  return reload(chargeId);
}

/** Aplica ao banco o estado que o PROVEDOR informou sobre o pagamento. */
async function applyProviderState(chargeId, info, actor = SYSTEM) {
  const charge = await PixCharge.findByPk(chargeId);
  if (!charge) return null;
  // Segurança: o pagamento consultado precisa ser o desta cobrança (referência externa e id do provedor batem).
  if ((info.externalReference && info.externalReference !== charge.id) || !charge.providerRef || info.providerRef !== charge.providerRef) {
    console.error(`[pix] pagamento ${info.providerRef} não corresponde à cobrança ${charge.id}; ignorado`);
    return reload(chargeId);
  }
  if (info.status === "paid") return fulfil(chargeId, info, actor);
  if (info.status === "cancelled" && charge.status === "pending") {
    await PixCharge.update({ status: new Date(charge.expiresAt) <= new Date() ? "expired" : "cancelled" }, { where: { id: chargeId, status: "pending" } });
  } else if (info.status === "refunded" && ["paid", "review"].includes(charge.status)) {
    await PixCharge.update(
      { status: "refunded", error: "Pix devolvido no provedor. O estoque/fatura NÃO foram revertidos automaticamente: ajuste manualmente, se necessário." },
      { where: { id: chargeId, status: { [Op.in]: ["paid", "review"] } } },
    );
    await audit({ actor, action: "pix.refunded", entityType: "pix_charge", entityId: chargeId, result: "failure", metadata: { amountCents: charge.amountCents } });
  }
  return expireIfDue(await reload(chargeId));
}

/** Consulta o provedor e atualiza uma cobrança pendente (confirmação mesmo sem webhook, ex.: ambiente local). */
async function refreshIfPending(charge, { force = false } = {}) {
  if (charge.status !== "pending") return charge;
  const provider = providerFor(charge.provider);
  const recent = charge.lastCheckedAt && Date.now() - new Date(charge.lastCheckedAt).getTime() < CHECK_INTERVAL_MS;
  if (!provider || !charge.providerRef || (recent && !force)) return expireIfDue(charge);
  try {
    await PixCharge.update({ lastCheckedAt: new Date() }, { where: { id: charge.id } });
    const info = await provider.getPayment(charge.providerRef);
    return (await applyProviderState(charge.id, info, SYSTEM)) ?? charge;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    console.error(`[pix] consulta da cobrança ${charge.id} falhou: ${e.code}`); // provedor fora do ar: segue com o estado local
    return expireIfDue(charge);
  }
}

/* ---------- Consultas do parceiro ---------- */

export async function getChargeFor({ partnerId, id }) {
  const charge = await PixCharge.findOne({ where: { id, partnerId }, include: withRefs }); // de outro parceiro => 404
  if (!charge) throw notFound("Cobrança");
  return refreshIfPending(charge);
}

export async function listChargesFor({ partnerId, page, pageSize }) {
  const { rows, count } = await PixCharge.findAndCountAll({
    where: { partnerId, status: { [Op.ne]: "failed" } }, include: withRefs, order: [["createdAt", "DESC"]], ...pageOf({ page, pageSize }),
  });
  return paged(rows.map((c) => chargeView(c)), count, { page, pageSize });
}

/* ---------- Webhook ---------- */

/**
 * Notificação do provedor: só traz o id do pagamento. Consulta o pagamento na API do provedor (fonte da verdade) e aplica.
 * Pagamento que não é de uma cobrança nossa (outra integração na mesma conta) é ignorado com 200 para não gerar reentregas.
 */
export async function handleNotification(providerName, paymentId, actor) {
  const provider = providerFor(providerName);
  if (!provider) throw new AppError(404, "NOT_FOUND", "Provedor desconhecido.");
  let info;
  try {
    info = await provider.getPayment(paymentId);
  } catch (e) {
    if (e instanceof AppError && e.code === "PIX_PAYMENT_NOT_FOUND") return { ignored: true };
    throw e; // indisponibilidade do provedor: erro 5xx => o provedor reenvia a notificação depois
  }
  if (!info.externalReference || !UUID.test(info.externalReference)) return { ignored: true };
  const charge = await PixCharge.findByPk(info.externalReference);
  if (!charge || charge.provider !== provider.name) return { ignored: true };
  const after = await applyProviderState(charge.id, info, actor);
  return { ignored: false, status: after?.status };
}

/* ---------- Administração ---------- */

export async function listCharges({ status, partnerId, purpose, page, pageSize }) {
  const where = {};
  if (status) where.status = status;
  if (partnerId) where.partnerId = partnerId;
  if (purpose) where.purpose = purpose;
  const { rows, count } = await PixCharge.findAndCountAll({
    where, include: [...withRefs, { model: Partner, attributes: ["id", "name"] }], order: [["createdAt", "DESC"]], ...pageOf({ page, pageSize }),
  });
  return paged(rows.map((c) => chargeView(c, { admin: true })), count, { page, pageSize });
}

/** Reconsulta o provedor e reaplica (cobrança em revisão, webhook perdido...). Seguro repetir: a entrega é idempotente. */
export async function reprocessCharge(id, actor) {
  const charge = await PixCharge.findByPk(id);
  if (!charge) throw notFound("Cobrança");
  const provider = providerFor(charge.provider);
  if (!provider) throw new AppError(409, "PIX_PROVIDER_MISMATCH", "O provedor configurado agora não é o desta cobrança.");
  if (!charge.providerRef) throw new AppError(409, "NO_PROVIDER_REF", "Cobrança sem pagamento no provedor.");
  const info = await provider.getPayment(charge.providerRef);
  await audit({ actor, action: "pix.reprocess", entityType: "pix_charge", entityId: id, metadata: { providerStatus: info.rawStatus } });
  return chargeView(await applyProviderState(id, info, actor), { admin: true });
}

/** Admin tratou à mão (lançou o estoque/pagamento e/ou devolveu o dinheiro): tira a cobrança da fila de revisão. */
export async function resolveCharge(id, { note }, actor) {
  const [n] = await PixCharge.update(
    { status: "paid", fulfilledAt: new Date(), error: `Resolvido manualmente por ${actor?.name ?? "administrador"}: ${note}`.slice(0, 500) },
    { where: { id, status: "review" } },
  );
  if (!n) throw new AppError(409, "NOT_IN_REVIEW", "Só cobranças em revisão podem ser resolvidas manualmente.");
  await audit({ actor, action: "pix.resolve", entityType: "pix_charge", entityId: id, metadata: { note } });
  return chargeView(await reload(id), { admin: true });
}

/** Somente com PIX_PROVIDER=mock (desenvolvimento): marca a cobrança como paga, como se o banco tivesse confirmado. */
export async function simulatePayment(id, actor) {
  const provider = getProvider();
  if (provider.name !== "mock") throw new AppError(404, "NOT_FOUND", "Rota não encontrada.");
  const charge = await PixCharge.findByPk(id);
  if (!charge) throw notFound("Cobrança");
  provider.simulate(charge.providerRef, "paid");
  const info = await provider.getPayment(charge.providerRef);
  return chargeView(await applyProviderState(id, info, actor), { admin: true });
}

/**
 * Job periódico: (1) confere no provedor as cobranças pendentes (webhook pode ter se perdido) e (2) expira as vencidas.
 * Falha de uma cobrança não interrompe as demais.
 */
export async function reconcile({ limit = 100 } = {}) {
  if (!pixEnabled()) return { checked: 0, paid: 0, expired: 0 };
  const provider = getProvider();
  const rows = await PixCharge.findAll({
    where: { status: "pending", provider: provider.name, providerRef: { [Op.ne]: null }, createdAt: { [Op.lt]: new Date(Date.now() - 2 * 60_000) } },
    order: [["expiresAt", "ASC"]], limit,
  });
  let checked = 0;
  let paid = 0;
  let expired = 0;
  for (const c of rows) {
    try {
      const after = await applyProviderState(c.id, await provider.getPayment(c.providerRef), SYSTEM);
      checked++;
      if (after?.status === "paid") paid++;
      if (after?.status === "expired") expired++; // vencida e sem pagamento no provedor
    } catch (e) {
      console.error(`[pix] conciliação da cobrança ${c.id}: ${e.code ?? e.message}`);
    }
  }
  const [others] = await PixCharge.update({ status: "expired" }, { where: { status: "pending", expiresAt: { [Op.lt]: new Date() } } });
  return { checked, paid, expired: expired + others };
}
