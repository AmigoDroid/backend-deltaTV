import crypto from "node:crypto";
import { Op, UniqueConstraintError } from "sequelize";
import {
  sequelize, Partner, AdminUser, License, Activation, Renewal, LicenseStockLedger,
} from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { STOCK_KINDS, balancesOf, move } from "./stock-ledger.js";
import { audit } from "../../shared/audit.js";
import { generateCode, hashCode } from "../../shared/crypto.js";
import { addMonthsUTC } from "../../shared/dates.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { activateLicenseById } from "../activations/activation.service.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";
import { ensurePlan } from "../licenses/plan.service.js";

/**
 * Estoque de licenças do revendedor: saldo por duração (em meses).
 *  - O admin LANÇA licenças no estoque (manual, com valor unitário opcional para o histórico) e pode ajustar.
 *  - O revendedor transfere para outro revendedor pelo e-mail dele e aplica ao MAC de um cliente (ativa ou renova).
 *  - O saldo vive em license_stock (CHECK quantity >= 0) e é alterado por UPDATE atômico: dois cliques/abas ao mesmo
 *    tempo nunca gastam a mesma licença. Todo movimento gera uma linha no extrato (license_stock_ledger).
 */
const live = { [Op.ne]: "revoked" };
export { STOCK_KINDS, balancesOf };

const ledgerOut = (r) => {
  const j = r.toJSON();
  return {
    id: j.id, at: j.createdAt, months: j.months, delta: j.delta, balanceAfter: j.balanceAfter, kind: j.kind,
    counterparty: j.counterparty ? { id: j.counterparty.id, name: j.counterparty.name } : null,
    deviceId: j.deviceId, unitPriceCents: j.unitPriceCents, note: j.note, actorName: j.actorName,
  };
};

/** Saldo atual + extrato paginado. Usado pelo painel admin (por parceiro) e pelo portal do revendedor. */
export async function stockOf(partnerId, { page = 1, pageSize = 20 } = {}) {
  const { rows, count } = await LicenseStockLedger.findAndCountAll({
    where: { partnerId },
    include: [{ model: Partner, as: "counterparty", attributes: ["id", "name"], required: false }],
    order: [["createdAt", "DESC"], ["id", "ASC"]], ...pageOf({ page, pageSize }),
  });
  return { balances: await balancesOf(partnerId), ledger: paged(rows.map(ledgerOut), count, { page, pageSize }) };
}

/* ---------- Administração (você) ---------- */

async function loadHolder(partnerId) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  if (!STOCK_KINDS.includes(partner.kind)) {
    throw new AppError(422, "NOT_A_RESELLER", "Só cadastros do tipo Revendedor (ou Conteúdo e revendedor) têm estoque de licenças.");
  }
  if (["cancelled", "blocked"].includes(partner.status)) throw new AppError(409, "INVALID_STATE", "Este cadastro não pode receber licenças.");
  return partner;
}

export async function grantStock(partnerId, { months, quantity, unitPriceCents, note }, actor) {
  await loadHolder(partnerId);
  await ensurePlan(months); // garante que a duração existe como plano (1–120 meses)
  await sequelize.transaction(async (t) => {
    const balance = await move(t, { partnerId, months, delta: quantity, kind: "grant", actor, unitPriceCents: unitPriceCents ?? null, note });
    await audit({
      actor, action: "stock.grant", entityType: "partner", entityId: partnerId,
      metadata: { months, quantity, unitPriceCents: unitPriceCents ?? null, balance, note }, transaction: t,
    });
  });
  return { balances: await balancesOf(partnerId) };
}

/** Correção manual (entrada ou saída). O saldo nunca fica negativo. */
export async function adjustStock(partnerId, { months, delta, note }, actor) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  await sequelize.transaction(async (t) => {
    const balance = await move(t, { partnerId, months, delta, kind: "adjust", actor, note });
    await audit({ actor, action: "stock.adjust", entityType: "partner", entityId: partnerId, metadata: { months, delta, balance, note }, transaction: t });
  });
  return { balances: await balancesOf(partnerId) };
}

/* ---------- Transferência entre revendedores (por e-mail) ---------- */

/**
 * Localiza o revendedor de destino pelo e-mail de um usuário do portal. Resposta igual para e-mail inexistente,
 * de outro tipo de conta ou de cadastro inativo (não revela quais e-mails existem). As rotas têm limite de taxa.
 */
export async function resolveRecipient(email, from) {
  const normalized = String(email ?? "").trim().toLowerCase();
  const user = normalized
    ? await AdminUser.findOne({
        where: { [Op.and]: [sequelize.where(sequelize.fn("lower", sequelize.col("email")), normalized), { role: "partner", status: "active" }] },
      })
    : null;
  const partner = user?.partnerId ? await Partner.findByPk(user.partnerId) : null;
  if (!partner || !STOCK_KINDS.includes(partner.kind) || effectivePartnerStatus(partner) !== "active") {
    throw new AppError(404, "RECIPIENT_NOT_FOUND", "Nenhum revendedor ativo encontrado com este e-mail.");
  }
  if (partner.id === from.id) throw new AppError(422, "SELF_TRANSFER", "Você não pode transferir para si mesmo.");
  return partner;
}

export async function lookupRecipient({ partner, email }) {
  const to = await resolveRecipient(email, partner);
  return { name: to.name };
}

export async function transferStock({ partner, actor, email, months, quantity, note }) {
  const to = await resolveRecipient(email, partner);
  const transferId = crypto.randomUUID();
  // Sempre na mesma ordem (por id) para duas transferências cruzadas nunca travarem uma à outra.
  const legs = [
    { partnerId: partner.id, delta: -quantity, kind: "transfer_out", counterpartyPartnerId: to.id },
    { partnerId: to.id, delta: quantity, kind: "transfer_in", counterpartyPartnerId: partner.id },
  ].sort((a, b) => (a.partnerId < b.partnerId ? -1 : 1));
  const balances = await sequelize.transaction(async (t) => {
    const after = {};
    for (const leg of legs) after[leg.kind] = await move(t, { ...leg, months, actor, transferId, note });
    await audit({
      actor, action: "stock.transfer", entityType: "partner", entityId: partner.id,
      metadata: { months, quantity, toPartnerId: to.id, toPartnerName: to.name, transferId, note }, transaction: t,
    });
    return after;
  });
  return { transferId, to: { name: to.name }, months, quantity, balanceAfter: balances.transfer_out, balances: await balancesOf(partner.id) };
}

/* ---------- Aplicar ao MAC do cliente ---------- */

async function applyOnce({ partner, actor, device, months }) {
  return sequelize.transaction(async (t) => {
    const lock = { transaction: t, lock: t.LOCK.UPDATE };
    const plan = await ensurePlan(months, { transaction: t });
    const now = new Date();
    // Licença viva deste MAC: primeiro a que ESTE revendedor concedeu pelo código dele (ativação de parceria com
    // granted_license_id); senão a licença individual (as ativações por parceria de conteúdo não contam).
    const granted = await Activation.findOne({
      where: { deviceId: device.id, partnerId: partner.id, status: live, grantedLicenseId: { [Op.ne]: null } }, ...lock,
    });
    const existing = granted ?? await Activation.findOne({
      where: { deviceId: device.id, partnerId: null, status: live, licenseId: { [Op.ne]: null } }, ...lock,
    });

    let action;
    let license;
    let activation;
    let expiresAt;
    if (existing) {
      // Renovação: soma ao saldo se ainda vale, ou conta a partir de agora se já venceu (mesma regra do admin).
      license = await License.findByPk(existing.grantedLicenseId ?? existing.licenseId, lock);
      if (!license || ["cancelled", "blocked"].includes(license.status)) {
        throw new AppError(409, "NOT_RENEWABLE", "A licença deste dispositivo está cancelada ou bloqueada. Fale com a plataforma.");
      }
      const previous = license.expiresAt;
      const base = license.expiresAt && license.expiresAt > now ? license.expiresAt : now;
      expiresAt = addMonthsUTC(base, months);
      await license.update({
        planId: plan.id, expiresAt, startsAt: license.startsAt ?? now,
        status: license.status === "pending" ? "active" : license.status,
        ...(license.ownerPartnerId ? {} : { ownerPartnerId: partner.id, assignedAt: now }),
      }, { transaction: t });
      await Renewal.create({ licenseId: license.id, planId: plan.id, previousExpiresAt: previous, newExpiresAt: expiresAt, createdBy: actor.id }, { transaction: t });
      await move(t, { partnerId: partner.id, months, delta: -1, kind: "consume", actor, deviceId: device.id, licenseId: license.id, note: "Renovação" });
      activation = existing;
      action = "renew";
    } else {
      // Nova licença nascida do estoque do revendedor (dono = ele), ativada neste MAC dentro da MESMA transação.
      const code = generateCode("LIC");
      license = await License.create({
        codeHash: hashCode(code), codeLast4: code.slice(-4), planId: plan.id, status: "pending", maxDevices: plan.maxDevices,
        ownerPartnerId: partner.id, assignedAt: now, createdBy: actor.id, notes: `Estoque do revendedor ${partner.name}`,
      }, { transaction: t });
      await move(t, { partnerId: partner.id, months, delta: -1, kind: "consume", actor, deviceId: device.id, licenseId: license.id, note: "Ativação" });
      const r = await activateLicenseById({
        licenseId: license.id, mac: device.mac, installationId: device.lastInstallationId,
        meta: { ip: actor.ip, userAgent: "reseller-stock-apply" }, transaction: t,
      });
      activation = r.activation;
      expiresAt = r.expiresAt;
      action = "activate";
    }
    await audit({
      actor, action: "stock.apply", entityType: "device", entityId: device.id,
      metadata: { mac: device.mac, months, licenseId: license.id, activationId: activation.id, result: action, expiresAt }, transaction: t,
    });
    return { action, months, expiresAt, activationId: activation.id, licenseId: license.id };
  });
}

/** Gasta 1 licença do estoque e a aplica ao dispositivo: ativa uma licença nova ou renova a que o MAC já tem. */
export async function applyStockToDevice({ partner, actor, device, months }) {
  let result;
  try {
    result = await applyOnce({ partner, actor, device, months });
  } catch (e) {
    if (!(e instanceof UniqueConstraintError)) throw e;
    try {
      result = await applyOnce({ partner, actor, device, months }); // corrida: reavalia uma vez (agora vira renovação)
    } catch (e2) {
      if (e2 instanceof UniqueConstraintError) throw new AppError(409, "MAC_IN_USE", "Este dispositivo foi alterado ao mesmo tempo. Consulte-o e tente novamente.");
      throw e2;
    }
  }
  clearMirrorAuth(); // renovar muda o vencimento: o espelho não pode seguir negando pelo cache
  return { ...result, balances: await balancesOf(partner.id) };
}
