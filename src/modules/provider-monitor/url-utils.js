/** Normaliza o destino Xtream para uma sondagem GET em /player_api.php.
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
