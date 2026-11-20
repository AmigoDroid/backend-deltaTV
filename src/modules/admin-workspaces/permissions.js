import {AppError} from "../../shared/errors.js";
// Permissões delegáveis à administração de uma rede. NUNCA inclui controle da VPS,
// configurações globais, dados de outras redes ou criação de outros administradores.
export const NETWORK_PERMISSIONS = Object.freeze([
  "network:dashboard:read",
  "network:partners:read", "network:partners:write", "network:partners:delete",
  "network:resellers:read", "network:resellers:write", "network:resellers:delete",
  "network:plans:read", "network:plans:write",
  "network:members:read", "network:members:write",
  "network:resources:read", "network:resources:write", "network:devices:read", "network:devices:write",
  "network:billing:read", "network:billing:write",
  "network:gateways:read", "network:gateways:write",
  "network:audit:read",
]);
export function normalizeNetworkPermissions(value) {
  if (!Array.isArray(value)) return [];
  const known = new Set(NETWORK_PERMISSIONS);
  const permissions = new Set(value.filter(item => typeof item === "string" && known.has(item)));
  // Configurar um gateway exige poder consultar o mesmo gateway, nunca recursos globais.
  if (permissions.has("network:gateways:write")) permissions.add("network:gateways:read");
  return [...permissions];
}
export function adminHasNetworkPermission(user, permission) {
  return user?.role === "superadmin" ||
    (user?.role === "admin" && NETWORK_PERMISSIONS.includes(permission) &&
      Array.isArray(user.delegatedPermissions) && user.delegatedPermissions.includes(permission));
}

export const NETWORK_LIMIT_KEYS = Object.freeze(["maxPartners", "maxResellers", "maxPlans", "maxDnsPerCode", "maxActivationsPerPartner"]);
export function normalizeNetworkLimits(input) {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const key of NETWORK_LIMIT_KEYS) {
    if (!Object.hasOwn(value,key)) continue;
    const n = value[key];
    if (n === null) { out[key] = null; continue; } // explicitamente sem limite
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error(`Limite inválido: ${key}`);
    out[key] = n;
  }
  return out;
}
export function enforceLimit(maximum, used, code) {
  if (maximum !== null && maximum !== undefined && used >= maximum) {
    throw new AppError(409,code,"Limite administrativo atingido. Peça à DeltaTV para ajustar o contrato da rede.");
  }
}
