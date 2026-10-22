/**
 * Variante de formato dos canais AO VIVO (padrão Xtream Codes).
 *
 * O Roku (e vários players de TV) toca HLS de forma confiável, mas nem sempre abre o MPEG-TS contínuo
 * (`/live/<usuario>/<senha>/<id>.ts`) que as listas M3U costumam trazer. Os painéis Xtream expõem o MESMO canal
 * também como HLS (`.m3u8`). O cliente pede a variante pela extensão-dica da URL do gateway
 * (`/api/v1/play/<lista>/<id>.m3u8` ou `.ts`) e o servidor converte a origem aqui, sem expor nada ao cliente.
 *
 * Só mexe em URLs que parecem canal Xtream (id numérico); qualquer outra origem é devolvida intacta.
 */
const XTREAM_LIVE = /^(\/live\/[^/]+\/[^/]+\/[^/.]+?)(?:\.(?:ts|m3u8))?$/i;
const XTREAM_PLAIN = /^(\/[^/]+\/[^/]+\/\d+)(?:\.(?:ts|m3u8))?$/i;

/** @param {string} originUrl URL de origem do canal  @param {"ts"|"m3u8"} wanted  extensão pedida pelo cliente */
export function liveVariantOrigin(originUrl, wanted) {
  if (wanted !== "ts" && wanted !== "m3u8") return originUrl;
  let u;
  try {
    u = new URL(originUrl);
  } catch {
    return originUrl;
  }
  const m = u.pathname.match(XTREAM_LIVE) || u.pathname.match(XTREAM_PLAIN);
  if (!m) return originUrl;
  u.pathname = `${m[1]}.${wanted}`;
  return u.href;
}
