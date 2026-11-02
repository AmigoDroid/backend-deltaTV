/** Controle puro, testável sem WebSocket e sem banco. */
export function canReceiveChange(user, partnerId) {
  return user?.role !== "partner" || (partnerId != null && String(user.partnerId) === String(partnerId));
}
export function sameSessionClaims(account, peer) {
  return !!account && account.status === "active" && account.role === peer.user.role &&
    String(account.partnerId ?? "") === String(peer.user.partnerId ?? "") &&
    account.tokenVersion === peer.tokenVersion;
}
