import { Op, QueryTypes } from "sequelize";
import { sequelize, Partner, CreditLedger, CreditRate, CreditPrice } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { STOCK_KINDS, move as stockMove, balancesOf } from "../stock/stock-ledger.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { creditMove, creditBalanceOf } from "./credit-ledger.js";

/**
 * Crédito pré-pago do revendedor. Regras (todas decididas no SERVIDOR, o front só escolhe duração e quantidade):
 *  - câmbio (R$ por crédito) e preço de cada licença (em créditos) são definidos só pelo admin;
 *  - crédito entra por recarga Pix ou ajuste do admin e sai SÓ para comprar licença (vai para o estoque);
 *  - não existe transferência entre parceiros, venda de volta nem saque.
 * A licença comprada cai no estoque e é usada pelos fluxos que já existem (aplicar a um MAC, renovar, código).
 */
export const MAX_CREDIT_RECHARGE = 10_000; // créditos por recarga Pix
export const MAX_BUY_QUANTITY = 1000;

/* ---------- Câmbio ---------- */

/** Centavos de R$ por 1 crédito para este parceiro (o dele sobrepõe o geral). null = recarga não configurada. */
export async function rateFor(partnerId, transaction) {
  const rows = await CreditRate.findAll({ where: { [Op.or]: [{ partnerId: null }, { partnerId }] }, raw: true, transaction });
  const own = rows.find((r) => r.partnerId === partnerId);
  const general = rows.find((r) => !r.partnerId);
  return (own ?? general)?.rateCents ?? null;
}

/* ---------- Preços (em créditos) ---------- */

/** Mesma regra dos preços em R$: o do parceiro sobrepõe o geral; active=false esconde a duração para ele. */
export function resolveCreditPrices(rows) {
  const map = new Map();
  for (const r of rows) if (!r.partnerId && r.active) map.set(r.months, { months: r.months, priceCredits: r.priceCredits, custom: false });
  for (const r of rows) {
    if (!r.partnerId) continue;
    if (r.active) map.set(r.months, { months: r.months, priceCredits: r.priceCredits, custom: true });
    else map.delete(r.months);
  }
  return [...map.values()].sort((a, b) => a.months - b.months);
}

export async function pricesFor(partnerId, transaction) {
  const rows = await CreditPrice.findAll({ where: { [Op.or]: [{ partnerId: null }, { partnerId }] }, raw: true, transaction });
  return resolveCreditPrices(rows);
}

async function priceOf(partnerId, months, transaction) {
  const found = (await pricesFor(partnerId, transaction)).find((p) => p.months === months);
  if (!found) throw new AppError(422, "NOT_FOR_SALE", "Esta duração de licença não está à venda por crédito. Escolha outra ou fale com a plataforma.");
  return found.priceCredits;
}

/* ---------- Apresentação ---------- */

const ledgerView = (r, { admin = false } = {}) => ({
  id: r.id, at: r.createdAt, kind: r.kind, delta: Number(r.delta), balanceAfter: Number(r.balanceAfter),
  rateCents: r.rateCents, months: r.months, quantity: r.quantity, unitPriceCredits: r.unitPriceCredits, note: r.note,
  ...(admin ? { actorName: r.actorName, partner: r.Partner ? { id: r.Partner.id, name: r.Partner.name } : null } : {}),
});

export async function listLedger({ partnerId, kind, page, pageSize }, { admin = false } = {}) {
  const where = {};
  if (partnerId) where.partnerId = partnerId;
  if (kind) where.kind = kind;
  const { rows, count } = await CreditLedger.findAndCountAll({
    where, order: [["createdAt", "DESC"], ["id", "ASC"]], ...pageOf({ page, pageSize }),
    ...(admin ? { include: [{ model: Partner, attributes: ["id", "name"] }] } : {}),
  });
  return paged(rows.map((r) => ledgerView(r, { admin })), count, { page, pageSize });
}

/** Tela do revendedor: saldo, câmbio efetivo, o que ele pode comprar e por quantos créditos. */
export async function overviewFor(partner, { pixEnabled }) {
  const [balance, rateCents, prices] = await Promise.all([creditBalanceOf(partner.id), rateFor(partner.id), pricesFor(partner.id)]);
  return {
    balance, rateCents, canRecharge: !!pixEnabled && !!rateCents, maxRecharge: MAX_CREDIT_RECHARGE,
    maxBuyQuantity: MAX_BUY_QUANTITY, prices,
  };
}

/* ---------- Compra de licença com crédito ---------- */

/**
 * Debita créditos e entrega as licenças no ESTOQUE do revendedor, na mesma transação. Preço vem da tabela do admin.
 * Para aplicar/renovar um MAC, o revendedor usa depois o estoque (fluxos que já existem).
 */
export async function buyLicenses({ partner, actor, months, quantity }) {
  if (!STOCK_KINDS.includes(partner.kind)) throw new AppError(422, "NOT_A_RESELLER", "Só revendedores compram licenças para estoque.");
  if (["cancelled", "blocked"].includes(partner.status)) throw new AppError(409, "INVALID_STATE", "Este cadastro não pode comprar licenças. Fale com a plataforma.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BUY_QUANTITY) {
    throw new AppError(422, "INVALID_QUANTITY", `Informe de 1 a ${MAX_BUY_QUANTITY} licenças.`);
  }
  const out = await sequelize.transaction(async (t) => {
    await ensurePlan(months, { transaction: t });
    const unit = await priceOf(partner.id, months, t);
    const total = unit * quantity;
    const rateCents = await rateFor(partner.id, t);
    const label = `${quantity} licença(s) de ${months} ${months === 1 ? "mês" : "meses"}`;
    const credit = await creditMove(t, {
      partnerId: partner.id, delta: -total, kind: "purchase", rateCents, months, quantity, unitPriceCredits: unit,
      note: `Compra de ${label}`, actor,
    });
    const stock = await stockMove(t, {
      partnerId: partner.id, months, delta: quantity, kind: "grant", actor,
      note: `Compra com crédito (${total} crédito${total === 1 ? "" : "s"})`,
    });
    await audit({
      actor, action: "credit.purchase", entityType: "partner", entityId: partner.id,
      metadata: { months, quantity, unitPriceCredits: unit, totalCredits: total, creditBalance: credit, stockBalance: stock }, transaction: t,
    });
    return { spent: total, unitPriceCredits: unit, months, quantity, balance: credit };
  });
  return { ...out, stock: await balancesOf(partner.id) };
}

/* ---------- Administração ---------- */

/** Ajuste manual do admin: crédito de cortesia/correção (+) ou estorno (−). O saldo nunca fica negativo. */
export async function adjustCredit(partnerId, { delta, note }, actor) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  if (!STOCK_KINDS.includes(partner.kind)) throw new AppError(422, "NOT_A_RESELLER", "Só revendedores têm carteira de créditos.");
  const balance = await sequelize.transaction(async (t) => {
    const b = await creditMove(t, { partnerId, delta, kind: "adjust", note, actor });
    await audit({ actor, action: "credit.adjust", entityType: "partner", entityId: partnerId, metadata: { delta, note, balance: b }, transaction: t });
    return b;
  });
  return { balance };
}

export async function listWallets({ q, page, pageSize }) {
  const like = q ? `%${String(q).replace(/[%_\\]/g, "\\$&")}%` : null;
  const where = `p.kind IN ('reseller','both')${like ? " AND p.name ILIKE :like" : ""}`;
  const [rows, counted] = await Promise.all([
    sequelize.query(
      `SELECT p.id, p.name, p.status, p.kind, COALESCE(w.balance, 0) AS balance
         FROM partners p LEFT JOIN credit_wallets w ON w.partner_id = p.id
        WHERE ${where} ORDER BY p.name ASC LIMIT :limit OFFSET :offset`,
      { replacements: { like, ...pageOf({ page, pageSize }) }, type: QueryTypes.SELECT },
    ),
    sequelize.query(`SELECT count(*) AS n FROM partners p WHERE ${where}`, { replacements: { like }, type: QueryTypes.SELECT }),
  ]);
  return paged(rows.map((r) => ({ id: r.id, name: r.name, status: r.status, kind: r.kind, balance: Number(r.balance) })), Number(counted[0].n), { page, pageSize });
}

const rateOut = (r) => ({ id: r.id, partnerId: r.partnerId, partnerName: r.Partner?.name ?? null, rateCents: r.rateCents, updatedAt: r.updatedAt });

/** Câmbio geral + os combinados com cada revendedor. */
export async function listRates() {
  const rows = await CreditRate.findAll({ include: [{ model: Partner, attributes: ["id", "name"] }], order: [["createdAt", "ASC"]] });
  return {
    general: rows.filter((r) => !r.partnerId).map(rateOut)[0] ?? null,
    custom: rows.filter((r) => r.partnerId).map(rateOut).sort((a, b) => String(a.partnerName).localeCompare(String(b.partnerName))),
  };
}

export async function setRate({ partnerId = null, rateCents }, actor) {
  if (partnerId && !(await Partner.findByPk(partnerId))) throw notFound("Parceiro");
  const row = await sequelize.transaction(async (t) => {
    let r = await CreditRate.findOne({ where: { partnerId }, transaction: t, lock: t.LOCK.UPDATE });
    const before = r?.rateCents ?? null;
    if (r) await r.update({ rateCents }, { transaction: t });
    else r = await CreditRate.create({ partnerId, rateCents }, { transaction: t });
    await audit({ actor, action: "credit.rate.set", entityType: "credit_rate", entityId: r.id, metadata: { partnerId, rateCents, before }, transaction: t });
    return r;
  });
  return { id: row.id, partnerId: row.partnerId, rateCents: row.rateCents };
}

export async function deleteRate(id, actor) {
  const r = await CreditRate.findByPk(id);
  if (!r) throw notFound("Câmbio");
  await r.destroy();
  await audit({ actor, action: "credit.rate.delete", entityType: "credit_rate", entityId: id, metadata: { partnerId: r.partnerId, rateCents: r.rateCents } });
}

const priceOut = (r) => ({ id: r.id, partnerId: r.partnerId, months: r.months, priceCredits: r.priceCredits, active: r.active, updatedAt: r.updatedAt });

export async function listPrices({ partnerId } = {}) {
  const rows = await CreditPrice.findAll({ where: { partnerId: partnerId ?? null }, order: [["months", "ASC"]] });
  return rows.map(priceOut);
}

export async function setPrice({ partnerId = null, months, priceCredits, active = true }, actor) {
  if (partnerId && !(await Partner.findByPk(partnerId))) throw notFound("Parceiro");
  const row = await sequelize.transaction(async (t) => {
    let r = await CreditPrice.findOne({ where: { partnerId, months }, transaction: t, lock: t.LOCK.UPDATE });
    if (r) await r.update({ priceCredits, active }, { transaction: t });
    else r = await CreditPrice.create({ partnerId, months, priceCredits, active }, { transaction: t });
    await audit({ actor, action: "credit.price.set", entityType: "credit_price", entityId: r.id, metadata: { partnerId, months, priceCredits, active }, transaction: t });
    return r;
  });
  return priceOut(row);
}

export async function deletePrice(id, actor) {
  const r = await CreditPrice.findByPk(id);
  if (!r) throw notFound("Preço");
  await r.destroy();
  await audit({ actor, action: "credit.price.delete", entityType: "credit_price", entityId: id, metadata: { partnerId: r.partnerId, months: r.months } });
}
