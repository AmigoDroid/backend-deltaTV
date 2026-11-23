import { inheritedPlanOverrides } from '../service-plans/plan.rules.js';

// Compatibilidade com o snapshot antigo: distingue cotas herdadas de condições
// negociadas individualmente, sem tratar 0 como ausência de override.
export const comparableLimit = value => value == null ? null : Number(value);
export const isReduction = (previous, next) => next != null && (previous == null || Number(next) < Number(previous));
export function contractInheritsLimit(row) {
 const previous = row.live_snapshot || row.package_snapshot;
 if (!previous || !Object.hasOwn(previous,'activationLimit') || row.mode == null) return false;
 const limit = comparableLimit(previous.activationLimit);
 return (limit == null ? row.mode === 'fixed_unlimited' : row.mode === 'fixed_limited' && comparableLimit(row.activation_limit) === limit);
}
export function effectivePackageQuota(row, catalog, change) {
 const overrides=inheritedPlanOverrides({tier:row.package_snapshot?.tier,
   maxAppsOverride:row.max_apps_override,maxServersOverride:row.max_servers_override},
   row.package_snapshot,row.live_snapshot?.explicitOverrides);
 const maxApps = overrides.maxAppsOverride == null ? Number(change.maxApps) : Number(overrides.maxAppsOverride);
 const dnsRaw = overrides.maxServersOverride == null ? change.maxDns : Number(overrides.maxServersOverride);
 const maxDns = dnsRaw === 0 ? null : comparableLimit(dnsRaw);
 const oldApps = overrides.maxAppsOverride == null ? Number(catalog.max_apps ?? 0) : Number(overrides.maxAppsOverride);
 const oldDnsRaw = overrides.maxServersOverride == null ? catalog.max_servers : Number(overrides.maxServersOverride);
 const oldDns = oldDnsRaw === 0 ? null : comparableLimit(oldDnsRaw);
 const oldActivation = row.mode === 'fixed_limited' ? comparableLimit(row.activation_limit) : null;
 const activationLimit = row.package_code && contractInheritsLimit(row) ? change.activationLimit : oldActivation;
 return { oldApps, maxApps, oldDns, maxDns, oldActivation, activationLimit };
}
