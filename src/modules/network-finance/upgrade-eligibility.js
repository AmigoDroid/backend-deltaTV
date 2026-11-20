import { createHash } from 'node:crypto';
/** Um plano é upgrade quando custa mais que o plano atual, sem considerar ordem ou recursos. */
export function isSelfServiceUpgrade(current, target) {
  if (!current || !target || current.key === target.key || !target.active || target.deletedAt || target.hiddenFromNetwork) return false;
  return Number.isSafeInteger(current.monthlyPriceCents) &&
    Number.isSafeInteger(target.monthlyPriceCents) &&
    target.monthlyPriceCents > current.monthlyPriceCents;
}

/** Compara o valor efetivo do contrato. Contas gratuitas legadas podem não ter catálogo do Master. */
export function upgradePriceBaseline(partner, assignment, catalog) {
  const contractPrice=partner?.billingModel==='fixed' && Number.isSafeInteger(partner.monthlyFeeCents) && partner.monthlyFeeCents>=0
    ? partner.monthlyFeeCents : null;
  if (catalog) return {key:catalog.key,monthlyPriceCents:contractPrice??catalog.monthlyPriceCents};
  if (contractPrice===0) return {key:assignment?.tier||'',name:'Plano gratuito atual',
    description:'Contrato gratuito já existente',monthlyPriceCents:0};
  return null;
}

/** Contratos personalizados não devem ser sobrescritos por autoatendimento. */
export function hasCustomPlanOverrides(assignment, catalog) {
 if (!assignment || !catalog) return true;
 const fields={maxServersOverride:'maxServers',autoFailoverOverride:'autoFailover',
  autoPriorityOverride:'autoPriority',emailAlertsOverride:'emailAlerts',detailedHistoryOverride:'detailedHistory'};
 return Object.entries(fields).some(([override,field])=>assignment[override]!=null && assignment[override]!==catalog[field]);
}

/** Congela as condições ofertadas para não aplicar um plano alterado após o Pix. */
export function upgradePlanSignature(plan) {
 const keys=['key','monthlyPriceCents','maxServers','activationLimit','validityDays','autoFailover',
  'autoPriority','emailAlerts','detailedHistory','canResellPanel','canCreateSubmasters',
  'canViewFinance','canManageGateways'];
 return plan?createHash('sha256').update(JSON.stringify(keys.map(k=>plan[k]??null))).digest('hex'):null;
}
