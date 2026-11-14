/** Funções puras: protegidas por testes e usadas pelas rotas e pelo serviço. */
// Limite técnico de INTEGER do PostgreSQL; não é uma quota comercial.
export const MAX_NETWORK_QUANTITY = 2_147_483_647;
export const resellerKind = (kind) => kind === "reseller" || kind === "both";
export const isNetworkMaster = (p) => p?.distributionRole === "master" && resellerKind(p?.kind);
export const networkPrice = (unit, quantity) => {
  if (!Number.isSafeInteger(unit) || unit < 1 || unit > 2_147_483_647 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_NETWORK_QUANTITY) return null;
  const total = unit * quantity;
  return Number.isSafeInteger(total) ? total : null;
};
export const canUseInvite = (invite, now = Date.now()) => !!invite && !invite.revoked_at
  && (invite.expires_at == null || new Date(invite.expires_at).getTime() > now)
  && (invite.max_uses == null || Number(invite.uses) < Number(invite.max_uses));
export const deriveNetworkLabel = (role, depth) => role !== "master" ? "Revenda" : depth > 0 ? "Submaster" : "Master";

/** Pernas contábeis; ordenadas por conta para reduzir deadlocks. Total sempre zero. */
export function purchaseLegs({buyerId,sellerId,months,quantity,total}) {
  if(buyerId===sellerId || !networkPrice(total/quantity,quantity)) return null;
  return {
    credits:[{id:buyerId,delta:-total},{id:sellerId,delta:total}].sort((a,b)=>a.id.localeCompare(b.id)),
    stock:[{id:buyerId,delta:quantity},{id:sellerId,delta:-quantity}].sort((a,b)=>a.id.localeCompare(b.id)),
  };
}

/** Pure predicates shared with financial and quota routes. */
export const quotaReached = (max, count) => max !== undefined && max !== null &&
  Number.isSafeInteger(Number(max)) && Number(count) >= Number(max);
export const expectedPriceMatches = (actual, expected) => Number.isSafeInteger(Number(actual)) &&
  Number.isSafeInteger(Number(expected)) && Number(actual) === Number(expected);
