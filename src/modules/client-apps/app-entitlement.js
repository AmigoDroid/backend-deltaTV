import { Partner, PartnerApp, PartnerServicePlan, ServicePlanCatalog } from '../../db/models/index.js';
import { defaultTier } from '../service-plans/plan.rules.js';
import { AppError } from '../../shared/errors.js';

export const slotError = () => new AppError(409, 'APP_SLOT_UNAVAILABLE', 'Seu plano não inclui app próprio disponível. Faça upgrade.');

// O lock do parceiro é obrigatório em TODO caminho que cria um vínculo; serializa claims simultâneos.
export async function effectiveAppSlots(partnerId, transaction, { lock = false } = {}) {
  if (lock) {
    const partner = await Partner.findByPk(partnerId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!partner) throw new AppError(404, 'PARTNER_NOT_FOUND', 'Parceiro não encontrado.');
  }
  const partner = await Partner.findByPk(partnerId, { transaction });
  if (!partner) throw new AppError(404, 'PARTNER_NOT_FOUND', 'Parceiro não encontrado.');
  const assigned = await PartnerServicePlan.findByPk(partnerId, { transaction });
  // Bloqueia downgrade concorrente do catálogo durante claim/atribuição.
  const catalog = await ServicePlanCatalog.findByPk(assigned?.tier || defaultTier(partner.kind), { transaction, ...(lock ? { lock: transaction.LOCK.SHARE } : {}) });
  const included = Number(assigned?.maxAppsOverride ?? catalog?.maxApps ?? 0);
  const used = await PartnerApp.count({ where: { partnerId, status: ['active', 'paused'] }, transaction });
  return { included, used, available: Math.max(0, included - used), plan: catalog?.name ?? null };
}

export async function assertAppSlot(partnerId, transaction) {
  const slots = await effectiveAppSlots(partnerId, transaction, { lock: true });
  if (slots.available < 1) throw slotError();
  return slots;
}

export async function assertNoSlotDowngrade(partnerId, limit, transaction) {
  const used = await PartnerApp.count({ where: { partnerId, status: ['active', 'paused'] }, transaction });
  if (used > limit) throw new AppError(409, 'APP_SLOTS_EXCEED_PLAN', `Este parceiro possui ${used} aplicativo(s). Desvincule antes de reduzir as vagas para ${limit}.`);
}
