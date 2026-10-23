import { Op, UniqueConstraintError } from "sequelize";
import { sequelize, Partner, PartnerCode, PartnerProvider, Activation, Invoice, AdminUser } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { normalizeShortCode, shortCodeProblem, randomNumericCode } from "./short-code.js";
import { pageOf, paged } from "../../shared/pagination.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { normalizeTiers } from "../billing/billing.calc.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";

export const AUTO_SUSPEND_REASON = "Suspensão automática por inadimplência";
const DEVICE_COUNT = `(SELECT count(*) FROM activations a WHERE a.partner_id = "Partner".id AND a.status <> 'revoked')`;
const CODE_ACTIVATIONS = `(SELECT count(*) FROM activations a WHERE a.partner_code_id = "PartnerCode".id AND a.status <> 'revoked')`;

const codeOut = (c) => {
  const j = c.toJSON();
  j.activationCount = Number(j.activationCount ?? 0);
  return j;
};
const findCodes = (partnerId) => PartnerCode.findAll({
  where: { partnerId }, attributes: { include: [[sequelize.literal(CODE_ACTIVATIONS), "activationCount"]] }, order: [["createdAt", "DESC"]],
});

const out = (p) => {
  const j = p.toJSON();
  j.effectiveStatus = effectivePartnerStatus(p);
  j.deviceCount = Number(j.deviceCount ?? 0);
  return j;
};

export async function listPartners({ q, status, page, pageSize }) {
  const where = {};
  if (status === "expired") Object.assign(where, { status: "active", endsAt: { [Op.lte]: new Date() } });
  else if (status) where.status = status;
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { slug: { [Op.iLike]: `%${q}%` } }];
  const { rows, count } = await Partner.findAndCountAll({
    where, attributes: { include: [[sequelize.literal(DEVICE_COUNT), "deviceCount"]] },
    order: [["name", "ASC"]], ...pageOf({ page, pageSize }),
  });
  return paged(rows.map(out), count, { page, pageSize });
}

export async function getPartner(id) {
  const p = await Partner.findByPk(id, { attributes: { include: [[sequelize.literal(DEVICE_COUNT), "deviceCount"]] } });
  if (!p) throw notFound("Parceiro");
  const [codes, invoices, providers] = await Promise.all([
    findCodes(id),
    Invoice.findAll({ where: { partnerId: id }, order: [["competence", "DESC"]], limit: 24 }),
    PartnerProvider.findAll({ where: { partnerId: id }, order: [["priority", "ASC"], ["createdAt", "ASC"]] }),
  ]);
  return { ...out(p), codes: codes.map(codeOut), invoices, providers };
}

function checkCommercial(input) {
  if (input.billingModel === "tiered") {
    const tiers = normalizeTiers(input.tiers);
    if (tiers.length === 0) throw new AppError(422, "TIERS_REQUIRED", "Informe ao menos uma faixa de cobrança.");
    if (tiers.filter((t) => t.upTo === null).length > 1) throw new AppError(422, "INVALID_TIERS", "Apenas uma faixa final (sem limite) é permitida.");
    input.tiers = tiers;
  }
}

export async function createPartner(input, actor) {
  checkCommercial(input);
  return sequelize.transaction(async (t) => {
    const { portalUser, ...data } = input;
    const partner = await Partner.create(data, { transaction: t });
    if (portalUser) {
      await AdminUser.create(
        { name: portalUser.name, email: portalUser.email, passwordHash: await hashPassword(portalUser.password), role: "partner", partnerId: partner.id },
        { transaction: t },
      );
    }
    await audit({ actor, action: "partner.create", entityType: "partner", entityId: partner.id, metadata: { slug: partner.slug }, transaction: t });
    return partner;
  });
}

export async function updatePartner(id, input, actor) {
  const updated = await sequelize.transaction(async (t) => {
    const p = await Partner.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p) throw notFound("Parceiro");
    const merged = { billingModel: p.billingModel, tiers: p.tiers, ...input };
    checkCommercial(merged);
    if (merged.tiers) input.tiers = merged.tiers;
    if (input.deviceLimit !== undefined && input.deviceLimit !== null) {
      const used = await Activation.count({ where: { partnerId: id, status: { [Op.ne]: "revoked" } }, transaction: t });
      if (input.deviceLimit < used) throw new AppError(409, "LIMIT_BELOW_USAGE", `Existem ${used} dispositivos ativos; reduza-os antes de baixar o limite.`);
    }
    await p.update(input, { transaction: t });
    await audit({ actor, action: "partner.update", entityType: "partner", entityId: id, metadata: input, transaction: t });
    return p;
  });
  clearMirrorAuth();
  return updated;
}

const TRANSITIONS = {
  suspend: { from: ["active"], to: "suspended", reason: true },
  block: { from: ["active", "suspended"], to: "blocked", reason: true },
  reactivate: { from: ["suspended", "blocked"], to: "active" },
  cancel: { from: ["active", "suspended", "blocked"], to: "cancelled", reason: true },
};

/** Afeta TODOS os dispositivos da parceria (qualquer código usado na ativação) na próxima requisição. */
export async function changePartnerStatus(id, action, { reason }, actor) {
  const rule = TRANSITIONS[action];
  const changed = await sequelize.transaction(async (t) => {
    const p = await Partner.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p) throw notFound("Parceiro");
    if (!rule.from.includes(p.status)) throw new AppError(409, "INVALID_STATE", `Não é possível '${action}' uma parceria '${p.status}'.`);
    if (rule.reason && !reason) throw new AppError(422, "REASON_REQUIRED", "Informe o motivo.");
    const previous = p.status;
    await p.update({ status: rule.to, statusReason: action === "reactivate" ? null : reason ?? null }, { transaction: t });
    await audit({ actor, action: `partner.${action}`, entityType: "partner", entityId: id, metadata: { from: previous, to: rule.to, reason }, transaction: t });
    return p;
  });
  clearMirrorAuth(); // afeta todos os dispositivos da parceria: o espelho não pode seguir autorizando pelo cache
  return changed;
}

export async function renewPartner(id, { endsAt }, actor) {
  const renewed = await sequelize.transaction(async (t) => {
    const p = await Partner.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p) throw notFound("Parceiro");
    const next = new Date(endsAt);
    if (next <= p.startsAt) throw new AppError(422, "INVALID_DATE", "A data de término deve ser posterior ao início.");
    const previous = p.endsAt;
    await p.update({ endsAt: next }, { transaction: t });
    await audit({ actor, action: "partner.renew", entityType: "partner", entityId: id, metadata: { from: previous, to: next }, transaction: t });
    return p;
  });
  clearMirrorAuth();
  return renewed;
}

/* ---------- Códigos curtos de parceria (únicos em toda a plataforma) ---------- */

// Gera um código numérico livre: começa com 4 dígitos e aumenta o tamanho se o espaço estiver cheio.
async function generateFreeCode() {
  for (let length = 4; length <= 8; length++) {
    for (let i = 0; i < 25; i++) {
      const candidate = randomNumericCode(length);
      if ((await PartnerCode.count({ where: { code: candidate } })) === 0) return candidate;
    }
  }
  throw new AppError(503, "CODE_GENERATION_FAILED", "Não foi possível gerar um código livre. Tente novamente.");
}

// Para validação em tempo real na tela (o banco continua sendo a garantia final de unicidade).
export async function checkCode(raw) {
  const code = normalizeShortCode(raw);
  const problem = shortCodeProblem(code);
  if (problem) return { code, valid: false, available: false, message: problem };
  const taken = (await PartnerCode.count({ where: { code } })) > 0;
  return { code, valid: true, available: !taken, message: taken ? "Este código já está em uso." : "Código disponível." };
}

/** `code` informado = código escolhido (409 se já existir); omitido = gerado automaticamente. */
export async function createCode(partnerId, { code, label, maxActivations, expiresAt }, actor) {
  const partner = await Partner.findByPk(partnerId);
  if (!partner) throw notFound("Parceiro");
  if (["cancelled", "blocked"].includes(partner.status)) throw new AppError(409, "INVALID_STATE", "Parceria não permite novos códigos.");

  const chosen = code ? normalizeShortCode(code) : null;
  if (chosen) {
    const problem = shortCodeProblem(chosen);
    if (problem) throw new AppError(422, "INVALID_CODE_FORMAT", problem);
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const value = chosen ?? (await generateFreeCode());
    try {
      return await sequelize.transaction(async (t) => {
        const row = await PartnerCode.create(
          { partnerId, code: value, label: label ?? null, maxActivations: maxActivations ?? null, expiresAt: expiresAt ?? null, createdBy: actor.id },
          { transaction: t },
        );
        await audit({ actor, action: "partner.code.create", entityType: "partner", entityId: partnerId, metadata: { codeId: row.id, code: value, generated: !chosen }, transaction: t });
        return { id: row.id, code: row.code };
      });
    } catch (e) {
      if (!(e instanceof UniqueConstraintError)) throw e;
      // Corrida: outro código igual foi gravado entre a checagem e o insert.
      if (chosen) throw new AppError(409, "CODE_TAKEN", "Este código já está em uso por outra parceria. Escolha outro.");
    }
  }
  throw new AppError(503, "CODE_GENERATION_FAILED", "Não foi possível gerar um código livre. Tente novamente.");
}

export async function listCodes(partnerId) {
  return (await findCodes(partnerId)).map(codeOut);
}

// Revogar um código impede NOVAS ativações; dispositivos já ativados permanecem vinculados à parceria.
export async function revokeCode(partnerId, codeId, actor) {
  return sequelize.transaction(async (t) => {
    await Partner.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE }); // mesma ordem de locks da ativação
    const c = await PartnerCode.findOne({ where: { id: codeId, partnerId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!c) throw notFound("Código");
    await c.update({ status: "revoked" }, { transaction: t });
    await audit({ actor, action: "partner.code.revoke", entityType: "partner", entityId: partnerId, metadata: { codeId }, transaction: t });
    return c;
  });
}
