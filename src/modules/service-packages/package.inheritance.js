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
 const maxApps = row.max_apps_override == null ? Number(change.maxApps) : Number(row.max_apps_override);
 const dnsRaw = row.max_servers_override == null ? change.maxDns : Number(row.max_servers_override);
 const maxDns = dnsRaw === 0 ? null : comparableLimit(dnsRaw);
 const oldApps = row.max_apps_override == null ? Number(catalog.max_apps ?? 0) : Number(row.max_apps_override);
 const oldDnsRaw = row.max_servers_override == null ? catalog.max_servers : Number(row.max_servers_override);
 const oldDns = oldDnsRaw === 0 ? null : comparableLimit(oldDnsRaw);
 const oldActivation = row.mode === 'fixed_limited' ? comparableLimit(row.activation_limit) : null;
 const activationLimit = row.package_code && contractInheritsLimit(row) ? change.activationLimit : oldActivation;
 return { oldApps, maxApps, oldDns, maxDns, oldActivation, activationLimit };
}
