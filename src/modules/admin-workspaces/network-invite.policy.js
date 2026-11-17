// Regras puras para convites de uso único ou links de divulgação por plano.
export const inviteUnavailable = (row,now=new Date()) => !row || Boolean(row.revokedAt) ||
  new Date(row.expiresAt)<=now || Boolean(row.acceptedAt && (row.maxUses??1)===1) ||
  (row.maxUses!==null && (row.useCount??0)>=(row.maxUses??1));
export function inviteRecipient(row, email){
  if(row.email)return row.email.trim().toLowerCase();
  return String(email||'').trim().toLowerCase();
}
export function remainingUses(row){
  return row.maxUses==null?null:Math.max(0,row.maxUses-(row.useCount??0));
}
