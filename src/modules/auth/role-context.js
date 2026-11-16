// Uma conta Admin pode manter uma identidade operacional separada, sem conceder
// permissões de administração ao token de Parceiro/Revenda.
export const PORTAL_AUDIENCES = Object.freeze(['partner','content_partner']);
export function loginContext(user, audience, partnerKind) {
  const target = audience || (user?.role === 'partner' ? 'partner' : 'admin');
  if (target === 'admin') return user?.role !== 'partner' ? 'admin' : null;
  if (!PORTAL_AUDIENCES.includes(target)) return null;
  if (!(user?.role === 'partner' || user?.role === 'admin') || !user?.partnerId) return null;
  if (target === 'content_partner' && !['content','both'].includes(partnerKind)) return null;
  if (target === 'partner' && user.role === 'admin' && !['reseller','both'].includes(partnerKind)) return null;
  return 'partner';
}
export function sessionContext(audience, persistedRole) {
  if (audience === 'admin') return 'admin';
  if (PORTAL_AUDIENCES.includes(audience)) return 'partner';
  if (audience === 'legacy' || audience == null) return persistedRole === 'partner' ? 'partner' : 'admin';
  return null;
}
export function roleForContext(persistedRole, context, hasPartner) {
  if (context === 'partner') return (['partner','admin'].includes(persistedRole) && hasPartner) ? 'partner' : null;
  return context === 'admin' && persistedRole !== 'partner' ? persistedRole : null;
}
