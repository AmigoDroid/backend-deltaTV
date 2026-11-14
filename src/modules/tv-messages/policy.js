// Falha fechada: ausência de partnerId nunca significa acesso global.
export function messageScope(user) {
  if (user?.role === 'superadmin') return { global: true, partner: null };
  if (user?.role === 'partner' && user.partnerId) return { global: false, partner: user.partnerId };
  return null;
}
export const OWNERSHIP_JOINS = `FROM activations a
 LEFT JOIN licenses g ON g.id=a.granted_license_id
 LEFT JOIN licenses l ON l.id=a.license_id`;
export const OWNERSHIP_WHERE = `a.status <> 'revoked' AND a.device_id IS NOT NULL
 AND (:global OR a.partner_id=:partner OR COALESCE(g.owner_partner_id,l.owner_partner_id)=:partner)`;
