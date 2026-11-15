/** Regras puras para convite comercial do PAINEL DO PARCEIRO. */
export const PORTAL_INVITE_TTL_MS=72*60*60*1000;
export const PORTAL_INVITE_TYPES=Object.freeze(['customer','submaster']);
export const normalizePortalInviteEmail=value=>String(value??'').trim().toLowerCase();
export function verifyPortalInviteInput({months,unitResaleCents,inviteType},plan) {
  if (!PORTAL_INVITE_TYPES.includes(inviteType)) throw new RangeError('Tipo de convite inválido');
  if (!Number.isSafeInteger(months)||months<1||months>120) throw new RangeError('Meses inválidos');
  if (!Number.isSafeInteger(unitResaleCents)||unitResaleCents<Number(plan.min_resale_cents)) throw new RangeError('Preço abaixo do piso comercial');
  return true;
}
export function portalInviteUrl(origin,token){
  const url=new URL(origin);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
    throw new Error('O portal de convites deve usar HTTPS fora do ambiente local');
  if(!/^[a-zA-Z0-9_-]{32,100}$/.test(token))throw new Error('Token inválido');
  return `${origin.replace(/\/+$/,'')}/convite-comercial#token=${encodeURIComponent(token)}`;
}
