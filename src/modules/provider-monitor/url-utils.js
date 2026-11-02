/** Caminho Xtream sem descartar subpastas do servidor. Não transporta credenciais. */
export function xtreamApiUrl(raw) {
  const base = new URL(String(raw).trim());
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("Invalid scheme");
  base.pathname = base.pathname.replace(/\/+$/, "") + "/";
  base.search = ""; base.hash = "";
  return new URL("player_api.php", base);
}
