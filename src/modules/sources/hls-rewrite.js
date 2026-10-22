/**
 * Reescrita de playlists HLS (.m3u8) para o gateway.
 *
 * Problema: a origem devolve segmentos como "/hls/<token>" (relativos ao host DELA). Servida pelo nosso proxy,
 * o player resolveria esse caminho contra o NOSSO host e receberia 404 — o vídeo nunca abre.
 * Solução: cada URI (segmentos, sub-playlists, chaves, mapas) é resolvida contra a URL final da origem e trocada
 * por um caminho do gateway com a URL de origem CIFRADA (nunca expõe host/credenciais do provedor).
 */

const MAX_URI_LEN = 4096;

/** true se o início do corpo é uma playlist HLS. */
export function isPlaylistHead(buf) {
  const head = Buffer.from(buf).subarray(0, 32).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  return head.startsWith("#EXTM3U");
}

/**
 * @param {string} text   corpo da playlist
 * @param {string} base   URL final da origem (resolve URIs relativas)
 * @param {(absUrl:string)=>string} wrap  devolve a URI do gateway para uma URL absoluta http(s)
 */
export function rewritePlaylist(text, base, wrap) {
  const resolve = (ref) => {
    const r = ref.trim();
    if (!r || r.length > MAX_URI_LEN) return null;
    try {
      const u = new URL(r, base);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  };

  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      if (line.trim() === "") return line;
      if (line.startsWith("#")) {
        // Tags com URI="..." (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF, ...)
        return line.replace(/URI="([^"]*)"/g, (whole, ref) => {
          const abs = resolve(ref);
          return abs ? `URI="${wrap(abs)}"` : whole;
        });
      }
      const abs = resolve(line);
      return abs ? wrap(abs) : line;
    })
    .join("\n");
}
