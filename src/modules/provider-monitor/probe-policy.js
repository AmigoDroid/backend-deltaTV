/** Verificação mínima de um endpoint Xtream SEM credenciais.
 * Não garante que o usuário/senha funcionem (o resolvedor valida depois).
 */
export function isPlausibleXtreamResponse({status, contentType='', sample=''}) {
  if (status !== 200) return false;
  const body = String(sample).trimStart();
  // Aceita JSON retornado pelo Xtream inclusive auth=0 (sem credenciais).
  // Rejeita páginas HTML de proxy, captive portal, painel administrativo e 404.
  if (!body.startsWith('{') && !body.startsWith('[')) return false;
  if (/text\/html/i.test(contentType)) return false;
  return true;
}

/** EMA mantém preferência estável diante de variações pequenas de latência. */
export function smoothLatency(previous, measured, alpha=0.35) {
  const next=Number(measured);
  if (!Number.isFinite(next) || next < 0) return previous ?? null;
  const prev=Number(previous);
  if (previous == null || !Number.isFinite(prev) || prev < 0) return Math.round(next);
  return Math.round(prev*(1-alpha)+next*alpha);
}
