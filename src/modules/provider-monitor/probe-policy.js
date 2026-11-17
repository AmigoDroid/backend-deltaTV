/** Política original da sondagem HTTP sem credenciais.
 * 2xx, 3xx e 4xx (exceto 429) indicam que o servidor respondeu.
 * Não significa autenticação nem funcionamento do serviço de streaming.
 */
export function isReachableHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 500 && status !== 429;
}

/** EMA mantém preferência estável diante de variações pequenas de latência. */
export function smoothLatency(previous, measured, alpha=0.35) {
  const next=Number(measured);
  if (!Number.isFinite(next) || next < 0) return previous ?? null;
  const prev=Number(previous);
  if (previous == null || !Number.isFinite(prev) || prev < 0) return Math.round(next);
  return Math.round(prev*(1-alpha)+next*alpha);
}
