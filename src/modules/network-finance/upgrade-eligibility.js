import { createHash } from 'node:crypto';
/** Não confundir ordem de exibição com nível do plano: aumento real de preço e benefícios preservados. */
export function isSelfServiceUpgrade(current, target) {
  if (!current || !target || current.key === target.key || !target.active || target.deletedAt || target.hiddenFromNetwork) return false;
  if (!Number.isSafeInteger(current.monthlyPriceCents) || !Number.isSafeInteger(target.monthlyPriceCents) ||
      target.monthlyPriceCents <= current.monthlyPriceCents) return false;
  // null representa "sem limite". Nenhum limite ou validade pode diminuir.
  for (const key of ['maxServers', 'activationLimit']) {
    const before = current[key] == null ? Infinity : current[key];
    const after = target[key] == null ? Infinity : target[key];
    if (!Number.isFinite(before) && Number.isFinite(after) || after < before) return false;
  }
  if (target.validityDays < current.validityDays) return false;
  for (const key of ['autoFailover', 'autoPriority', 'emailAlerts', 'detailedHistory']) {
    if (current[key] && !target[key]) return false;
  }
  // Permissões comerciais/financeiras exigem autorização do Master, mesmo em planos mais caros.
  for (const key of ['canResellPanel', 'canCreateSubmasters', 'canViewFinance', 'canManageGateways']) {
    if (Boolean(current[key]) !== Boolean(target[key])) return false;
  }
  return true;
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
