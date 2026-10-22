/**
 * Teto de sessões simultâneas por ativação. Ao criar uma nova, remove as MAIS ANTIGAS que excederem o teto.
 * Função pura (o serviço aplica dentro da transação). `cap` < 1 é tratado como 1.
 * Por que não revogar todas: em recuperação por MAC não dá para distinguir a TV legítima de quem só conhece o MAC;
 * revogar tudo a cada chamada permitiria derrubar a TV de qualquer um. O teto limita o abuso sem isso.
 */
export function sessionsToRevoke(sessions, cap, now = new Date()) {
  const keep = Math.max(1, cap) - 1; // abre espaço para a nova
  const live = sessions
    .filter((s) => !s.revokedAt && new Date(s.expiresAt) > now)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const excess = live.length - keep;
  return excess > 0 ? live.slice(0, excess).map((s) => s.id) : [];
}
