/** Autorização acontece nas rotas. Este módulo resolve somente o transporte.
 * Nginx recebe um IP validado e fixado; nunca resolve novamente o domínio da
 * origem. Nenhuma URL é recebida de cabeçalhos arbitrários do cliente.
 */
import net from 'node:net';
import { createHash } from 'node:crypto';
import { isPlaylistHead, readMediaHead, isHlsContentType } from '../modules/sources/hls-rewrite.js';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { safeGet, parseHttpUrl, isPrivateAddress } from './ssrf.js';

export const NGINX_MEDIA_LOCATION = '/_deltatv_media';
export const NGINX_MEDIA_MARKER = 'deltatv-media-v1';
const UA = ['Mozilla/5.0', 'VLC/3.0.18 LibVLC/3.0.18', null];
const cache = new Map();
const pending = new Map();
const TTL_MS = 15000;
let generation = 0;
const MAX_CACHE = 2000;

export const clearMediaResolutionCache = () => { generation++; cache.clear(); pending.clear(); };
export function pinnedMediaTarget(raw, connectedAddress) {
  const source = parseHttpUrl(raw);
  if (source.username || source.password) throw new AppError(400, 'INVALID_URL', 'Não use credenciais HTTP embutidas na origem.');
  let address = String(connectedAddress || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  if (!net.isIP(address) || (!env.allowPrivateSources && isPrivateAddress(address))) {
    throw new AppError(502, 'ORIGIN_NOT_ALLOWED', 'Origem de mídia não permitida.');
  }
  const target = new URL(source);
  target.hostname = net.isIPv6(address) ? `[${address}]` : address;
  target.hash = '';
  return { target: target.href, host: source.host, tlsName: source.hostname.replace(/^\[|\]$/g, '') };
}

export function assertNginxMediaGateway(req) {
  if (req.headers['x-delta-media-gateway'] !== NGINX_MEDIA_MARKER) {
    throw new AppError(503, 'NGINX_MEDIA_NOT_CONFIGURED', 'O proxy de mídia do Nginx ainda não está configurado nesta API.');
  }
}

async function probe(raw, { signal } = {}) {
  const initial = parseHttpUrl(raw);
  if (initial.username || initial.password) throw new AppError(400, 'INVALID_URL', 'Não use credenciais HTTP embutidas na origem.');
  const headers = { accept: '*/*', 'accept-encoding': 'identity' };
  for (const userAgent of UA) {
    const sent = { ...headers, ...(userAgent ? { 'user-agent': userAgent } : {}) };
    let response;
    let isGet = false;
    try {
      response = await safeGet(raw, { method: 'HEAD', headers: sent, signal, timeoutMs: 15000 });
      // Alguns painéis não implementam HEAD. O GET de reserva só é inspecionado;
      // nunca há retransmissão do corpo binário em modo Nginx.
      if ([405, 501].includes(response.statusCode)) {
        response.destroy();
        response = await safeGet(raw, { headers: sent, signal, timeoutMs: 15000 });
        isGet = true;
      }
      if ([403, 406].includes(response.statusCode) && userAgent !== UA.at(-1)) continue;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new AppError(response.statusCode === 404 ? 404 : 502, 'ORIGIN_ERROR', 'A origem de mídia não respondeu corretamente.', { upstreamStatus: response.statusCode });
      }
      let finalUrl = response.finalUrl || raw;
      let contentType = String(response.headers['content-type'] || '');
      let playlist = isHlsContentType(contentType) || /\.m3u8$/i.test(new URL(finalUrl).pathname);
      // Origens sem MIME confiável também podem entregar uma playlist num .php,
      // .ts ou URL sem extensão. Inspecione apenas o prefixo nesses casos.
      if (!playlist && !/^(?:video|audio)\//i.test(contentType)) {
        if (!isGet) {
          response.destroy();
          response = await safeGet(finalUrl, { headers: sent, signal, timeoutMs: 15000 });
          if (response.statusCode < 200 || response.statusCode >= 300) throw new AppError(502, 'ORIGIN_ERROR', 'A origem não respondeu à inspeção da mídia.');
          finalUrl = response.finalUrl || finalUrl;
          contentType = String(response.headers['content-type'] || '');
        }
        playlist = isHlsContentType(contentType) || isPlaylistHead((await readMediaHead(response[Symbol.asyncIterator]())).value);
      }
      const pinned = pinnedMediaTarget(finalUrl, response.connectedAddress);
      return { ...pinned, finalUrl, userAgent, playlist };
    } finally { response?.destroy(); }
  }
  throw new AppError(502, 'ORIGIN_ERROR', 'A origem recusou a mídia.');
}

/** Cache somente da resolução, nunca da autorização ou do conteúdo do cliente. */
export async function resolveNginxMedia(raw, options = {}) {
  const key = createHash("sha256").update(String(raw)).digest("hex");
  const currentGeneration = generation;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  // Requisições com sinal individual não compartilham cancelamento entre clientes.
  if (!options.signal && pending.has(key)) return pending.get(key);
  const task = probe(raw, options).then(value => {
    if (currentGeneration === generation) { cache.delete(key); cache.set(key, { at: Date.now(), value }); }
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
    return value;
  }).finally(() => { if (!options.signal && currentGeneration === generation) pending.delete(key); });
  if (!options.signal) pending.set(key, task);
  return task;
}

export function sendNginxMedia(req, res, resolved) {
  assertNginxMediaGateway(req);
  if (resolved.playlist) throw new AppError(502, 'PLAYLIST_REQUIRES_REWRITE', 'A playlist precisa ser processada pela API.');
  res.statusCode = 200;
  res.removeHeader('content-length');
  res.removeHeader('content-type');
  res.setHeader('X-Accel-Redirect', NGINX_MEDIA_LOCATION);
  res.setHeader('X-Delta-Origin-Target', resolved.target);
  res.setHeader('X-Delta-Origin-Host', resolved.host);
  res.setHeader('X-Delta-Origin-TLS-Name', resolved.tlsName);
  res.setHeader('X-Delta-Origin-UA', resolved.userAgent || '');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end();
}

/** true = Nginx assumiu o corpo; false = playlist continua no Node para reescrita. */
export async function tryNginxMedia(req, res, target, report) {
  assertNginxMediaGateway(req);
  const resolved = await resolveNginxMedia(target);
  if (resolved.playlist) { res.setHeader("X-Delta-Media-Transport", "node-playlist"); return false; }
  report?.({state:'handoff',origin:resolved.finalUrl,transport:'nginx',upstreamFamily:net.isIP(new URL(resolved.target).hostname.replace(/^\[|\]$/g,''))||null});
  sendNginxMedia(req, res, resolved);
  return true;
}
