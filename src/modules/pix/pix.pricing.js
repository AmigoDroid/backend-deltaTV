import { Op } from "sequelize";
import { sequelize, LicensePrice, Partner } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { resolvePrices } from "./price-rules.js";

/**
 * Preço de venda das licenças por duração (em meses), em centavos.
 *  - Linha sem partnerId = tabela geral.
 *  - Linha com partnerId = preço combinado com aquele revendedor: sobrepõe a geral.
 *    Com active=false a duração deixa de ser vendida para ele (mesmo existindo na tabela geral).
 */

export async function pricesFor(partnerId) {
  const rows = await LicensePrice.findAll({ where: { [Op.or]: [{ partnerId: null }, { partnerId }] }, raw: true });
  return resolvePrices(rows);
}

/** Preço unitário (centavos) de uma duração para este revendedor; sem preço => não está à venda. */
export async function priceOf(partnerId, months) {
  const found = (await pricesFor(partnerId)).find((p) => p.months === months);
  if (!found) throw new AppError(422, "NOT_FOR_SALE", "Esta duração de licença não está à venda por Pix. Escolha outra ou fale com a plataforma.");
  return found.priceCents;
}

/* ---------- Administração ---------- */

const out = (r) => ({ id: r.id, partnerId: r.partnerId, months: r.months, priceCents: r.priceCents, active: r.active, updatedAt: r.updatedAt });

/** partnerId informado: só os preços daquele revendedor; senão a tabela geral. */
export async function listPrices({ partnerId } = {}) {
  const rows = await LicensePrice.findAll({ where: { partnerId: partnerId ?? null }, order: [["months", "ASC"]] });
  return rows.map(out);
}

export async function setPrice({ partnerId = null, months, priceCents, active = true }, actor) {
  if (partnerId && !(await Partner.findByPk(partnerId))) throw notFound("Parceiro");
  const row = await sequelize.transaction(async (t) => {
    let r = await LicensePrice.findOne({ where: { partnerId, months }, transaction: t, lock: t.LOCK.UPDATE });
    if (r) await r.update({ priceCents, active }, { transaction: t });
    else r = await LicensePrice.create({ partnerId, months, priceCents, active }, { transaction: t });
    await audit({ actor, action: "pix.price.set", entityType: "license_price", entityId: r.id, metadata: { partnerId, months, priceCents, active }, transaction: t });
    return r;
  });
  return out(row);
}

export async function deletePrice(id, actor) {
  const r = await LicensePrice.findByPk(id);
  if (!r) throw notFound("Preço");
  await r.destroy();
  await audit({ actor, action: "pix.price.delete", entityType: "license_price", entityId: id, metadata: { partnerId: r.partnerId, months: r.months } });
}
