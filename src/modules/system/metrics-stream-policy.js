// Ritmo do painel Superadmin. WebSocket é o transporte; esta constante governa a coleta.
// Intervalo mínimo evita saturar o event loop da VPS com amostragem excessiva.
export function metricsStreamInterval(value) {
  if (value == null || String(value).trim() === "") return 500;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.max(250, Math.min(2000, Math.trunc(ms))) : 500;
}
