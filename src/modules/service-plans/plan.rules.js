// Capacidades são resolvidas no backend; não confiar em controles escondidos no React.
export const TIERS = Object.freeze({
  reseller_basic: Object.freeze({label:"Revenda · Básico",maxServers:1,autoFailover:false,autoPriority:false,emailAlerts:false,detailedHistory:false}),
  partner_professional: Object.freeze({label:"Parceiro · Profissional",maxServers:4,autoFailover:true,autoPriority:false,emailAlerts:true,detailedHistory:false}),
  partner_premium: Object.freeze({label:"Parceiro · Premium",maxServers:8,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true}),
});
export const defaultTier = kind => kind === "reseller" ? "reseller_basic" : "partner_professional";
// Um snapshot de atribuição não é uma exceção contratual: valores copiados
// do pacote devem acompanhar o catálogo. Exceções explícitas são preservadas.
export const PLAN_OVERRIDE_FIELDS = Object.freeze({
  maxAppsOverride:'maxApps', maxServersOverride:'maxDns',
  autoFailoverOverride:'autoFailover', autoPriorityOverride:'autoPriority',
  emailAlertsOverride:'emailAlerts', detailedHistoryOverride:'detailedHistory',
});
export function inheritedPlanOverrides(record={},snapshot=null,explicitOverrides={}) {
  const result={...record};
  if (!snapshot || snapshot.tier!==record.tier) return result;
  for (const [field,snapshotField] of Object.entries(PLAN_OVERRIDE_FIELDS)) {
    const value=record[field];
    if (value==null || explicitOverrides?.[field]===true || !Object.hasOwn(snapshot,snapshotField)) continue;
    const previous=snapshot[snapshotField];
    const copied=field==='maxServersOverride'
      ? (previous==null ? Number(value)===0 : Number(value)===Number(previous))
      : field==='maxAppsOverride'
        ? Number(value)===Number(previous)
        : typeof previous==='boolean' && value===previous;
    if(copied)result[field]=null;
  }
  return result;
}
export function featuresFor(tier, overrides={}, catalog=null) {
  if (!catalog && !Object.hasOwn(TIERS,tier)) throw new Error("Plano de recursos desconhecido");
  const base = catalog ? {
    label: catalog.name, maxServers: catalog.maxServers, maxApps: catalog.maxApps ?? 0,
    autoFailover: catalog.autoFailover, autoPriority: catalog.autoPriority,
    emailAlerts: catalog.emailAlerts, detailedHistory: catalog.detailedHistory,
  } : TIERS[tier];
  const result={...base};
  for(const [field,override] of Object.entries({
    maxApps:"maxAppsOverride", maxServers:"maxServersOverride",autoFailover:"autoFailoverOverride",autoPriority:"autoPriorityOverride",
    emailAlerts:"emailAlertsOverride",detailedHistory:"detailedHistoryOverride",
  })) if(overrides[override]!==null && overrides[override]!==undefined) result[field]=overrides[override];
  // null representa plano sem limite; a exceção 0 também significa sem limite.
  // Os padrões Básico/Profissional/Premium continuam com suas cotas negociadas.
  if (result.maxServers === 0) result.maxServers = null;
  if (result.maxServers !== null && (!Number.isInteger(result.maxServers) || result.maxServers < 1 || result.maxServers > 2147483647)) {
    throw new Error("Limite de URLs inválido");
  }
  if(!result.autoFailover)result.autoPriority=false;
  return result;
}
