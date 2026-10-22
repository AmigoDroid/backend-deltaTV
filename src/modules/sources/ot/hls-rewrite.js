/**
 * Reescrita de playlists HLS (.m3u8) para o gateway.
 *
 * Provedores IPTV costumam enviar segmentos com caminho relativo ao SERVIDOR DELES
 * (ex.: "/hls/<token>"). Se a playlist passa pelo gateway sem reescrita, o player
 * resolve esse caminho contra o host do gateway e recebe 404. Aqui cada URI da
 * playlist vira uma URL absoluta do gateway (/api/v1/play/seg?t=<token>) que
 * carrega, assinada, a URL real do provedor — assim os segmentos também passam
 * pela revalidação de acesso e as URLs/credenciais do provedor não vão ao cliente.
 */
import { signJwt } from "../../shared/crypto.js";
import { AppError } from "../../shared/errors.js";

export const SEGMENT_PATH = "/api/v1/play/seg";
// Validade do token de segmento. O acesso do dispositivo continua sendo
// reavaliado no banco a cada requisição, então um TTL longo não impede revogação.
export const SEGMENT_TOKEN_TTL = 30 * 24 * 3600;
export const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

const URI_ATTR = /URI="([^"]*)"/gi;

/** A resposta é uma playlist HLS? (content-type ou extensão .m3u8 da URL final) */
export function isHlsResponse(headers, url) {
  const type = String(headers?.["content-type"] ?? "").toLowerCase();
  if (type.includes("mpegurl")) return true;
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function readPlaylistText(stream, limit = MAX_PLAYLIST_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      throw new AppError(502, "PLAYLIST_TOO_LARGE", "Playlist da origem excede o tamanho máximo.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const looksLikePlaylist = (text) => /^\uFEFF?\s*#EXTM3U/i.test(text.slice(0, 64));

/**
 * Reescreve todas as URIs (linhas de mídia e atributos URI="…") de uma playlist.
 * `baseUrl` = URL FINAL da playlist (após redirecionamentos), usada para resolver
 * caminhos relativos. `toGateway(absoluteUrl)` devolve a URL do gateway.
 */
export function rewritePlaylist(text, baseUrl, toGateway) {
  const map = (uri) => {
    const raw = uri.trim();
    if (!raw || /^(data|blob):/i.test(raw)) return uri;
    let abs;
    try {
      abs = new URL(raw, baseUrl);
    } catch {
      return uri;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return uri;
    return toGateway(abs.href);
  };

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith("#")) return line.replace(URI_ATTR, (_m, uri) => `URI="${map(uri)}"`);
      return map(line);
    })
    .join("\n");
}

/** Cria o tradutor URL do provedor → URL do gateway para o dispositivo/sessão atual. */
export function segmentUrlFactory({ activationId, sessionId }) {
  return (absoluteUrl) => {
    const token = signJwt({ typ: "seg", sid: sessionId, aid: activationId, u: absoluteUrl }, SEGMENT_TOKEN_TTL);
    return `${SEGMENT_PATH}?t=${token}`;
  };
}
