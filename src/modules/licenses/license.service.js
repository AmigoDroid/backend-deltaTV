import { Op } from "sequelize";
import {
  sequelize, License, Plan, Customer, Activation, Payment, Renewal, Device,
} from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { generateCode, hashCode } from "../../shared/crypto.js";
import { addMonthsUTC } from "../../shared/dates.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { effectiveLicenseStatus } from "../access/access.policy.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";

const DEVICE_COUNT = `(SELECT count(*) FROM activations a WHERE a.license_id = "License".id AND a.status <> 'revoked')`;

const out = (l) => {
  const j = l.toJSON();
  delete j.codeHash;
  j.effectiveStatus = effectiveLicenseStatus(l);
  j.deviceCount = Number(j.deviceCount ?? 0);
  return j;
};

export async function listLicenses({ q, status, planId, expiringInDays, page, pageSize }) {
  const where = {};
  const now = new Date();
  if (status === "expired") Object.assign(where, { status: "active", expiresAt: { [Op.lte]: now } });
  else if (status === "active") Object.assign(where, { status: "active", expiresAt: { [Op.gt]: now } });
  else if (status) where.status = status;
  if (planId) where.planId = planId;
  // Combina com o filtro de status (ex.: "expiradas" + "vence em 7 dias" = nenhuma), em vez de sobrescrevê-lo.
  if (expiringInDays) where.expiresAt = { ...where.expiresAt, [Op.between]: [now, new Date(now.getTime() + expiringInDays * 86400000)] };
  if (q) {
    where[Op.or] = [
      { "$Customer.name$": { [Op.iLike]: `%${q}%` } },
      { "$Customer.email$": { [Op.iLike]: `%${q}%` } },
      { codeLast4: q.toUpperCase() },
    ];
  }
  const { rows, count } = await License.findAndCountAll({
    where,
    attributes: { include: [[sequelize.literal(DEVICE_COUNT), "deviceCount"]] },
    include: [{ model: Customer }, { model: Plan, attributes: ["id", "name", "durationMonths"] }],
    order: [["createdAt", "DESC"]], ...pageOf({ page, pageSize }), distinct: true, subQuery: false,
  });
  return paged(rows.map(out), count, { page, pageSize });
}

export async function getLicense(id) {
  const l = await License.findByPk(id, {
    attributes: { include: [[sequelize.literal(DEVICE_COUNT), "deviceCount"]] },
    include: [
      { model: Customer }, { model: Plan },
      { model: Activation, include: [Device] },
      { model: Renewal, include: [Plan] },
      { model: Payment },
    ],
    order: [[Activation, "activatedAt", "DESC"], [Renewal, "createdAt", "DESC"], [Payment, "paidAt", "DESC"]],
  });
  if (!l) throw notFound("Licença");
  return out(l);
}

export async function createLicense(input, actor) {
  return sequelize.transaction(async (t) => {
    const plan = await Plan.findByPk(input.planId, { transaction: t });
    if (!plan || !plan.active) throw new AppError(422, "INVALID_PLAN", "Plano inválido ou inativo.");
    const customer = input.customer ? await Customer.create(input.customer, { transaction: t }) : null;
    const code = generateCode("LIC");
    const pending = input.startOnFirstActivation === true;
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const license = await License.create(
      {
        codeHash: hashCode(code), codeLast4: code.slice(-4), planId: plan.id, customerId: customer?.id ?? null,
        status: pending ? "pending" : "active",
        startsAt: pending ? null : startsAt,
        expiresAt: pending ? null : addMonthsUTC(startsAt, plan.durationMonths),
        maxDevices: input.maxDevices ?? plan.maxDevices, notes: input.notes ?? null, createdBy: actor.id,
      },
      { transaction: t },
    );
    if (input.payment) {
      await Payment.create(
        { licenseId: license.id, amountCents: input.payment.amountCents, method: input.payment.method ?? null,
          provider: "manual", providerRef: input.payment.reference ?? null, origin: "admin", confirmedBy: actor.id, note: input.payment.note ?? null },
        { transaction: t },
      );
    }
    await audit({ actor, action: "license.create", entityType: "license", entityId: license.id, metadata: { planId: plan.id, pending }, transaction: t });
    // O código em texto puro é devolvido UMA vez; o banco guarda apenas o hash.
    return { license: out(license), code };
  });
}

export async function updateLicense(id, input, actor) {
  return sequelize.transaction(async (t) => {
    const l = await License.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!l) throw notFound("Licença");
    if (input.maxDevices !== undefined) {
      const used = await Activation.count({ where: { licenseId: id, status: { [Op.ne]: "revoked" } }, transaction: t });
      if (input.maxDevices < used) throw new AppError(409, "LIMIT_BELOW_USAGE", `Existem ${used} dispositivos vinculados; remova ativações antes de reduzir o limite.`);
      l.maxDevices = input.maxDevices;
    }
    if (input.notes !== undefined) l.notes = input.notes;
    await l.save({ transaction: t });
    if (input.customer) {
      if (l.customerId) await Customer.update(input.customer, { where: { id: l.customerId }, transaction: t });
      else {
        const customer = await Customer.create(input.customer, { transaction: t });
        await l.update({ customerId: customer.id }, { transaction: t });
      }
    }
    await audit({ actor, action: "license.update", entityType: "license", entityId: id, metadata: input, transaction: t });
    return l;
  });
}

const TRANSITIONS = {
  suspend: { from: ["active"], to: "suspended" },
  block: { from: ["active", "suspended"], to: "blocked", reason: true },
  reactivate: { from: ["suspended", "blocked"], to: "active" },
  cancel: { from: ["pending", "active", "suspended", "blocked"], to: "cancelled", reason: true },
};

/** Alterar o status afeta TODOS os dispositivos da licença na próxima requisição (gate no backend). */
export async function changeLicenseStatus(id, action, { reason }, actor) {
  const rule = TRANSITIONS[action];
  const changed = await sequelize.transaction(async (t) => {
    const l = await License.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!l) throw notFound("Licença");
    if (!rule.from.includes(l.status)) throw new AppError(409, "INVALID_STATE", `Não é possível '${action}' uma licença '${l.status}'.`);
    if (rule.reason && !reason) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo.");
    const previous = l.status;
    await l.update({ status: rule.to, statusReason: action === "reactivate" ? null : reason ?? null }, { transaction: t });
    await audit({ actor, action: `license.${action}`, entityType: "license", entityId: id, metadata: { from: previous, to: rule.to, reason }, transaction: t });
    return l;
  });
  clearMirrorAuth(); // afeta todos os dispositivos da licença
  return changed;
}

export async function renewLicense(id, input, actor) {
  const renewed = await sequelize.transaction(async (t) => {
    const l = await License.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!l) throw notFound("Licença");
    if (["cancelled", "blocked"].includes(l.status)) {
      throw new AppError(409, "NOT_RENEWABLE", "Reative a licença antes de renovar (canceladas não podem ser renovadas).");
    }
    const plan = await Plan.findByPk(input.planId ?? l.planId, { transaction: t });
    if (!plan || !plan.active) throw new AppError(422, "INVALID_PLAN", "Plano inválido ou inativo.");
    const now = new Date();
    const previous = l.expiresAt;
    // Renovar antes do vencimento soma ao saldo; depois do vencimento, conta a partir de agora.
    const base = l.expiresAt && l.expiresAt > now ? l.expiresAt : now;
    const next = addMonthsUTC(base, plan.durationMonths);
    await l.update(
      {
        planId: plan.id, expiresAt: next, startsAt: l.startsAt ?? now,
        status: l.status === "pending" ? "active" : l.status,
        ...(input.planId ? { maxDevices: plan.maxDevices } : {}),
      },
      { transaction: t },
    );
    const payment = input.payment
      ? await Payment.create(
          { licenseId: l.id, amountCents: input.payment.amountCents, method: input.payment.method ?? null,
            provider: "manual", providerRef: input.payment.reference ?? null, origin: "admin", confirmedBy: actor.id, note: input.payment.note ?? null },
          { transaction: t },
        )
      : null;
    await Renewal.create({ licenseId: l.id, planId: plan.id, previousExpiresAt: previous, newExpiresAt: next, paymentId: payment?.id ?? null, createdBy: actor.id }, { transaction: t });
    await audit({ actor, action: "license.renew", entityType: "license", entityId: id, metadata: { planId: plan.id, from: previous, to: next }, transaction: t });
    return l;
  });
  clearMirrorAuth();
  return renewed;
}
