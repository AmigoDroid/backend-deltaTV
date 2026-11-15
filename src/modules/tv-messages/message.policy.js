/** Puro: controla escopo de mensagens por parceiro ou administração. */
export function messageScope(user) {
  if (user?.role === 'partner' && user.partnerId) return { partnerId: user.partnerId };
  if (user?.role === 'superadmin' || user?.role === 'admin') return { partnerId: null };
  return null;
}
export function uniqueDeviceIds(ids) { return [...new Set(ids)].sort(); }
export function canonicalMessagePayload({ audience, deviceIds, title, message, expiresInDays }) {
  return JSON.stringify({ audience, deviceIds: audience === 'selected' ? uniqueDeviceIds(deviceIds) : [],
    title, message, expiresInDays });
}
