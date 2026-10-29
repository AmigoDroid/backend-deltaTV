import crypto from "node:crypto";
import net from "node:net";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { decryptSecret } from "../../shared/crypto.js";
import { safeGet } from "../../shared/ssrf.js";

/**
 * Cliente da API Xtream Codes (player_api.php) — catálogo SOB DEMANDA.
 *
 * Em vez de baixar e gravar a playlist M3U inteira (centenas de milhares de linhas por TV), o servidor consulta o
 * painel do provedor por pasta e guarda só um cache curto em memória (com limite de tamanho). Nada vai para o banco.
 *
 * Segurança: todas as chamadas passam por safeGet (SSRF/DNS rebinding); usuário/senha nunca saem do servidor,
 * nem em log nem em chave de cache (a chave é um hash).
 */

const UA = "Mozilla/5.0 (IPTV-Licensing)";
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const RETRY_STATUS = new Set([401, 403, 404, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500, 3000];

/* ---------- Detecção: esta ativação usa um painel Xtream? ---------- */

/** Extrai {base, username, password} de uma URL de playlist no padrão Xtream, ou null. */
export function accountFromPlaylistUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const q = u.searchParams;
  if (/\/get\.php$/i.test(u.pathname) && q.get("username") && q.get("password")) {
    return { base: u.origin, username: q.get("username"), password: q.get("password") };
  }
  const m = u.pathname.match(/^\/playlist\/([^/]+)\/([^/]+)\/[^/]+$/i); // /playlist/USER/PASS/m3u_plus
  if (m) return { base: u.origin, username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) };
  return null;
}

const accountKey = (a) =>
  crypto.createHash("sha256").update(`${a.base}\u0000${a.username}\u0000${a.password}`).digest("hex").slice(0, 32);

/**
 * Conta Xtream da ativação (ou null se for outro tipo de lista / recurso desligado).
 * Lista própria (URL cifrada) ou provedor de parceria com template padrão /get.php.
 */
export async function xtreamAccountOf(activation) {
  if (!activation) return null;
  try {
    if (activation.playlistUrlEnc) {
      const a = accountFromPlaylistUrl(decryptSecret(activation.playlistUrlEnc));
      return a ? { ...a, key: accountKey(a) } : null;
    }
    if (activation.providerId && activation.credentialsEnc) {
      const { PartnerProvider } = await import("../../db/models/index.js"); // só quando necessário (evita carregar o banco à toa)
      const provider = await PartnerProvider.findByPk(activation.providerId);
      if (!provider || provider.status !== "active") return null;
      if (!/^\/get\.php\?/i.test(provider.playlistTemplate || "")) return null; // só o padrão Xtream
      const { username, password } = JSON.parse(decryptSecret(activation.credentialsEnc));
      if (!username || !password) return null;
      const a = { base: provider.baseUrl, username: String(username), password: String(password) };
      return { ...a, key: accountKey(a) };
    }
  } catch (err) {
    console.error(`[xtream] conta Xtream ilegível (activation ${activation.id}): ${err.message}`);
    return null;
  }
  return null;
}

/* ---------- Cache em memória (TTL + limite de bytes + uma busca por vez) ---------- */

const cache = new Map(); // chave -> { value, at, ttl, size }
const inflight = new Map();
let cacheBytes = 0;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    cacheBytes -= hit.size;
    return undefined;
  }
  return hit;
}

function cacheSet(key, value, ttl, size) {
  const old = cache.get(key);
  if (old) cacheBytes -= old.size;
  cache.delete(key);
  cache.set(key, { value, at: Date.now(), ttl, size });
  cacheBytes += size;
  const max = env.xtreamCacheMaxBytes;
  for (const [k, v] of cache) {
    if (cacheBytes <= max || k === key) break;
    cache.delete(k); // remove os mais antigos primeiro
    cacheBytes -= v.size;
  }
}

/** Para testes e para o invalidador de cache. */
export function clearXtreamCache() {
  cache.clear();
  inflight.clear();
  cacheBytes = 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Chamadas HTTP ---------- */

async function readJson(res) {
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size > MAX_JSON_BYTES) {
      res.destroy();
      throw new AppError(502, "ORIGIN_TOO_LARGE", "Resposta da origem excede o tamanho máximo.");
    }
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { json: JSON.parse(text), size };
  } catch {
    throw new AppError(502, "ORIGIN_INVALID_RESPONSE", "A origem não retornou uma resposta válida.");
  }
}

async function requestJson(account, params) {
  const qs = new URLSearchParams({ username: account.username, password: account.password, ...params });
  const url = `${account.base}/player_api.php?${qs}`;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await safeGet(url, { headers: { "user-agent": UA }, timeoutMs: 20000 });
    } catch (e) {
      if (e instanceof AppError && e.status < 500) throw e; // destino bloqueado etc.: não adianta repetir
      if (attempt >= RETRY_DELAYS_MS.length) throw new AppError(502, "ORIGIN_UNAVAILABLE", "Não foi possível acessar a origem.");
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.statusCode === 200) {
      try {
        return await readJson(res);
      } catch (e) {
        // Página de erro no lugar do JSON (o painel às vezes devolve HTML): trata como falha temporária.
        if (e?.code !== "ORIGIN_INVALID_RESPONSE" || attempt >= RETRY_DELAYS_MS.length) throw e;
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
    }
    res.resume();
    if (!RETRY_STATUS.has(res.statusCode) || attempt >= RETRY_DELAYS_MS.length) {
      throw new AppError(502, "ORIGIN_ERROR", "A origem não respondeu corretamente.");
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

/**
 * Consulta com cache. `ttlSeconds`: validade. Falha da origem com cópia antiga disponível: serve a antiga.
 * Resposta que não é lista/objeto (credencial inválida costuma devolver vazio) vira [].
 */
export async function xtreamCall(account, params, { ttlSeconds }) {
  const key = `${account.key}|${new URLSearchParams(params)}`;
  const hit = cacheGet(key);
  if (hit) return hit.value;

  let pending = inflight.get(key);
  if (!pending) {
    pending = requestJson(account, params)
      .then(({ json, size }) => {
        cacheSet(key, json, ttlSeconds * 1000, size);
        return json;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/* ---------- Servidor de streams ---------- */

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Endereço onde os streams são servidos, informado pelo próprio painel (server_info).
 * Pode ser diferente do host da API (ex.: API atrás de Cloudflare, vídeo direto no IP do servidor).
 */
export async function streamOriginOf(account) {
  const info = await xtreamCall(account, {}, { ttlSeconds: env.xtreamServerInfoTtlSeconds });
  const s = info?.server_info;
  const base = new URL(account.base);
  let host = base.hostname;
  let port = base.port;
  let protocol = base.protocol.replace(":", "");
  if (s && typeof s.url === "string" && HOST_RE.test(s.url)) {
    host = s.url;
    protocol = s.server_protocol === "https" ? "https" : "http";
    const p = Number.parseInt(protocol === "https" ? s.https_port : s.port, 10);
    port = Number.isInteger(p) && p > 0 && p < 65536 ? String(p) : "";
  }
  if (net.isIPv6(host.replace(/^\[|\]$/g, "")) && !host.startsWith("[")) host = `[${host}]`;
  return `${protocol}://${host}${port ? `:${port}` : ""}`;
}

const EXT_OK = /^[A-Za-z0-9]{2,5}$/;

/** URL de reprodução (com credenciais — só para uso do servidor). */
export async function playUrlFor(account, { kind, id, ext }) {
  const origin = await streamOriginOf(account);
  const u = encodeURIComponent(account.username);
  const p = encodeURIComponent(account.password);
  const e = EXT_OK.test(ext ?? "") ? ext.toLowerCase() : null;
  // Formato único: <origem>/{live|movie|series}/<usuário>/<senha>/<id>.<ext> (ao vivo sempre com o segmento /live/).
  if (kind === "live") return `${origin}/live/${u}/${p}/${id}.${e === "m3u8" ? "m3u8" : "ts"}`;
  if (kind === "movie") return `${origin}/movie/${u}/${p}/${id}.${e ?? "mp4"}`;
  return `${origin}/series/${u}/${p}/${id}.${e ?? "mp4"}`;
}
