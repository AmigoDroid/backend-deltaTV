/** Normaliza a URL da API Xtream para verificação autenticada no resolvedor.
 * Aceita DNS na raiz, em subpasta ou já terminado em /player_api.php.
 * Não transporta credenciais (usuário/senha na URL nem query string).
 */
export function xtreamApiUrl(raw) {
  const base = new URL(String(raw).trim());
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Invalid scheme");

  // Evita /player_api.php/player_api.php quando a URL cadastrada já aponta à API.
  const path = base.pathname.replace(/\/+$/, "").replace(/\/player_api\.php$/i, "");
  base.pathname = `${path}/player_api.php`;
  base.search = "";
  base.hash = "";
  base.username = "";
  base.password = "";
  return base;
}

/** URL usada SOMENTE pela sondagem leve do monitor.
 * Preserva o caminho que o parceiro cadastrou, sem acrescentar player_api.php.
 * Não envia usuário/senha da URL ou parâmetros de consulta para uma sondagem anônima.
 * O resolvedor autenticado continua usando xtreamApiUrl(), sem alterações.
 */
export function monitorProbeUrl(raw) {
  const target = new URL(String(raw).trim());
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Invalid scheme");
  target.username = "";
  target.password = "";
  target.search = "";
  target.hash = "";
  return target;
}
