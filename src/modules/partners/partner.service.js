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
import { SIGNUP_PENDING_REASON } from "./reseller-signup.service.js";
import { STOCK_KINDS, balancesOf, quantityOf } from "../stock/stock-ledger.js";

export const AUTO_SUSPEND_REASON = "Suspensão automática por inadimplência";
const DEVICE_COUNT = `(SELECT count(*) FROM activations a WHERE a.partner_id = "Partner".id AND a.status <> 'revoked')`;
const CODE_ACTIVATIONS = `(SELECT count(*) FROM activations a WHERE a.partner_code_id = "PartnerCode".id AND a.status <> 'revoked')`;

const codeOut = (c, stock = null) => {
  const j = c.toJSON();
  j.activationCount = Number(j.activationCount ?? 0);
  // Quantas licenças da duração deste código ainda existem no estoque do dono (null = código sem licença).
  j.stockAvailable = j.licenseMonths && stock ? stock.get(j.licenseMonths) ?? 0 : j.licenseMonths ? 0 : null;
  return j;
};
const stockMap = async (partnerId) => new Map((await balancesOf(partnerId)).map((b) => [b.months, b.quantity]));
const findCodes = (partnerId) => PartnerCode.findAll({
  where: { partnerId }, attributes: { include: [[sequelize.literal(CODE_ACTIVATIONS), "activationCount"]] }, order: [["createdAt", "DESC"]],
  include: [{ model: PartnerProvider, as: "provider", attributes: ["id", "name", "baseUrl", "status"], required: false }],
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
  else if (status === "pending") Object.assign(where, { status: "suspended", statusReason: SIGNUP_PENDING_REASON }); // cadastros públicos aguardando aprovação
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
  const [codes, stock, invoices, providers] = await Promise.all([
    findCodes(id),
    stockMap(id),
    Invoice.findAll({ where: { partnerId: id }, order: [["competence", "DESC"]], limit: 24 }),
    PartnerProvider.findAll({ where: { partnerId: id }, order: [["priority", "ASC"], ["createdAt", "ASC"]] }),
  ]);
  return { ...out(p), codes: codes.map((c) => codeOut(c, stock)), invoices, providers };
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

/**
 * Resolve o servidor do código. `providerId` informado: precisa ser DESTE parceiro e estar ativo.
 * Omitido (undefined): se o parceiro tem exatamente um servidor, usa-o; senão fica NULL (comportamento antigo:
 * a ativação testa os servidores ativos do parceiro).
 */
async function resolveProviderId(partnerId, providerId, transaction) {
  if (providerId === undefined) {
    const all = await PartnerProvider.findAll({ where: { partnerId }, attributes: ["id"], limit: 2, transaction });
    return all.length === 1 ? all[0].id : null;
  }
  if (providerId === null) return null;
  const provider = await PartnerProvider.findOne({ where: { id: providerId, partnerId }, transaction });
  if (!provider) throw new AppError(422, "INVALID_PROVIDER", "Servidor inválido para esta parceria.");
  if (provider.status !== "active") throw new AppError(422, "PROVIDER_DISABLED", "O servidor escolhido está desativado.");
  return provider.id;
}

/**
 * Licença (duração em meses) do código.
 *  - Revendedor: todo código precisa estar atrelado a uma licença do estoque dele, e o estoque precisa ter essa duração.
 *  - Conteúdo: não tem estoque; o código não pode ter licença. "Conteúdo e revendedor": opcional.
 * `current` = valor atual do código (na edição): manter o mesmo valor não exige saldo de novo.
 */
async function resolveLicenseMonths(partner, licenseMonths, { transaction, current } = {}) {
  if (licenseMonths === undefined) return current ?? null;
  if (licenseMonths === null) {
    if (partner.kind === "reseller") {
      throw new AppError(422, "LICENSE_MONTHS_REQUIRED", "Todo código de revendedor precisa estar atrelado a uma licença do seu estoque.");
    }
    return null;
  }
  if (!STOCK_KINDS.includes(partner.kind)) {
    throw new AppError(422, "CODE_LICENSE_NOT_ALLOWED", "Só cadastros do tipo Revendedor (ou Conteúdo e revendedor) têm licenças em estoque.");
  }
  if (licenseMonths !== current && (await quantityOf(partner.id, licenseMonths, transaction)) < 1) {
    throw new AppError(422, "NO_STOCK_FOR_DURATION", `Não há licença de ${licenseMonths} ${licenseMonths === 1 ? "mês" : "meses"} no estoque. Lance licenças dessa duração antes de criar o código.`);
  }
  return licenseMonths;
}

/** `code` informado = código escolhido (409 se já existir); omitido = gerado automaticamente. */
export async function createCode(partnerId, { code, label, maxActivations, expiresAt, providerId, licenseMonths }, actor) {
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
        const resolvedProviderId = await resolveProviderId(partnerId, providerId, t);
        const months = await resolveLicenseMonths(partner, licenseMonths ?? null, { transaction: t });
        const row = await PartnerCode.create(
          {
            partnerId, code: value, label: label ?? null, maxActivations: maxActivations ?? null, expiresAt: expiresAt ?? null,
            providerId: resolvedProviderId, licenseMonths: months, createdBy: actor.id,
          },
          { transaction: t },
        );
        await audit({
          actor, action: "partner.code.create", entityType: "partner", entityId: partnerId,
          metadata: { codeId: row.id, code: value, generated: !chosen, providerId: resolvedProviderId, licenseMonths: months }, transaction: t,
        });
        return { id: row.id, code: row.code, providerId: row.providerId, licenseMonths: row.licenseMonths };
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
  const [codes, stock] = await Promise.all([findCodes(partnerId), stockMap(partnerId)]);
  return codes.map((c) => codeOut(c, stock));
}

/**
 * Edita um código existente (inclusive apontá-lo para outro servidor). Só vale para NOVAS ativações:
 * dispositivos já ativados mantêm o servidor que usam hoje.
 */
export async function updateCode(partnerId, codeId, input, actor) {
  const updated = await sequelize.transaction(async (t) => {
    const partner = await Partner.findByPk(partnerId, { transaction: t, lock: t.LOCK.UPDATE });
    const c = await PartnerCode.findOne({ where: { id: codeId, partnerId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!partner || !c) throw notFound("Código");
    const patch = {};
    for (const k of ["label", "maxActivations", "expiresAt"]) if (input[k] !== undefined) patch[k] = input[k];
    if (input.providerId !== undefined) patch.providerId = await resolveProviderId(partnerId, input.providerId, t);
    // Só vale para NOVAS ativações: licenças já vendidas por este código não mudam.
    if (input.licenseMonths !== undefined) {
      patch.licenseMonths = await resolveLicenseMonths(partner, input.licenseMonths, { transaction: t, current: c.licenseMonths });
    }
    if (patch.maxActivations != null) {
      const used = await Activation.count({ where: { partnerCodeId: c.id, status: { [Op.ne]: "revoked" } }, transaction: t });
      if (patch.maxActivations < used) throw new AppError(409, "LIMIT_BELOW_USAGE", `Este código tem ${used} ativações; o limite não pode ser menor.`);
    }
    await c.update(patch, { transaction: t });
    await audit({ actor, action: "partner.code.update", entityType: "partner", entityId: partnerId, metadata: { codeId, ...patch }, transaction: t });
    return c;
  });
  return codeOut(await PartnerCode.findByPk(updated.id, {
    attributes: { include: [[sequelize.literal(CODE_ACTIVATIONS), "activationCount"]] },
    include: [{ model: PartnerProvider, as: "provider", attributes: ["id", "name", "baseUrl", "status"], required: false }],
  }), await stockMap(partnerId));
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
