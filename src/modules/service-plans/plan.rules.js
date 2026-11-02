// Capacidades são resolvidas no backend; não confiar em controles escondidos no React.
export const TIERS = Object.freeze({
  reseller_basic: Object.freeze({label:"Revenda · Básico",maxServers:1,autoFailover:false,autoPriority:false,emailAlerts:false,detailedHistory:false}),
  partner_professional: Object.freeze({label:"Parceiro · Profissional",maxServers:4,autoFailover:true,autoPriority:false,emailAlerts:true,detailedHistory:false}),
  partner_premium: Object.freeze({label:"Parceiro · Premium",maxServers:8,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true}),
});
export const defaultTier = kind => kind === "reseller" ? "reseller_basic" : "partner_professional";
export function featuresFor(tier, overrides={}, catalog=null) {
  if (!catalog && !Object.hasOwn(TIERS,tier)) throw new Error("Plano de recursos desconhecido");
  const base = catalog ? {
    label: catalog.name, maxServers: catalog.maxServers,
    autoFailover: catalog.autoFailover, autoPriority: catalog.autoPriority,
    emailAlerts: catalog.emailAlerts, detailedHistory: catalog.detailedHistory,
  } : TIERS[tier];
  const result={...base};
  for(const [field,override] of Object.entries({
    maxServers:"maxServersOverride",autoFailover:"autoFailoverOverride",autoPriority:"autoPriorityOverride",
    emailAlerts:"emailAlertsOverride",detailedHistory:"detailedHistoryOverride",
  })) if(overrides[override]!==null && overrides[override]!==undefined) result[field]=overrides[override];
  if(!Number.isInteger(result.maxServers)||result.maxServers<1||result.maxServers>8) throw new Error("Limite inválido");
  if(!result.autoFailover)result.autoPriority=false;
  return result;
}
