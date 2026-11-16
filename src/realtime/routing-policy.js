/** Controle puro, testável sem WebSocket e sem banco. */
export function canReceiveChange(user, partnerId) {
  // Administradores de rede não recebem eventos globais nem IDs de parceiros de outras contas.
  if (user?.role === "admin") return false;
  return user?.role !== "partner" || (partnerId != null && String(user.partnerId) === String(partnerId));
}
export function sameSessionClaims(account, peer) {
  return !!account && account.status === "active" && account.role === peer.user.role &&
    String(account.partnerId ?? "") === String(peer.user.partnerId ?? "") &&
    account.tokenVersion === peer.tokenVersion;
}
