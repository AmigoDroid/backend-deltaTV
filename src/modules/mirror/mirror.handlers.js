import crypto from "node:crypto";
import net from "node:net";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { encryptSecret, decryptSecret } from "../../shared/crypto.js";
import { parseHttpUrl, isPrivateAddress } from "../../shared/ssrf.js";
import { relay } from "../../shared/relay.js";
import { playUrlFor } from "../xtream/xtream.client.js";
import { m3uMirrorRewriter } from "./m3u-rewrite.js";
import { MIRROR_PASS } from "./mode.js";

/**
 * Rota espelho Xtream: o app fala com ESTE servidor como se fosse o painel.
 * Cada handler recebe `ctx` já autenticado (token válido, sessão ativa, licença/parceria liberada):
 *   ctx = { token, mode: "proxy"|"redirect", cred: {baseUrl, username, password}, publicBase, recheck }
 * Os handlers não conhecem Express nem banco: só montam a URL de origem e decidem entre 302 e retransmissão.
 */

export function redirectTo(res, target) {
  const url = parseHttpUrl(target);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !env.allowPrivateSources &&
    (host === "localhost" || (net.isIP(host) && isPrivateAddress(host)))
  ) {
    throw new AppError(502, "ORIGIN_NOT_ALLOWED", "Origem não permitida.");
  }
  res.statusCode = 302;
  res.setHeader("Location", url.href);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

const accountOf = (cred) => ({
  base: cred.baseUrl,
  username: cred.username,
  password: cred.password,
  key: crypto
    .createHash("sha256")
    .update(`${cred.baseUrl}\0${cred.username}\0${cred.password}`)
    .digest("hex")
    .slice(0, 32),
});

const hlsWrapFor = (ctx) => (abs) =>
  `/hls/${encodeURIComponent(ctx.token)}/${encryptSecret(abs)}`;

/** Troca, na resposta de autenticação do painel, os dados reais pelos do espelho. */
export function rewriteAuthJson(buf, ctx) {
  const j = JSON.parse(buf.toString("utf8"));
  if (!j || typeof j !== "object") return null;
  if (j.user_info && typeof j.user_info === "object") {
    j.user_info.username = ctx.token;
    j.user_info.password = MIRROR_PASS;
  }
  if (j.server_info && typeof j.server_info === "object") {
    const b = new URL(ctx.publicBase);
    const https = b.protocol === "https:";
    const port = b.port || (https ? "443" : "80");
    j.server_info.url = b.hostname;
    j.server_info.port = port;
    j.server_info.https_port = port;
    j.server_info.server_protocol = https ? "https" : "http";
  }
  return JSON.stringify(j);
}

/** GET /player_api.php — API do painel (auth, categorias, listas, detalhes). */
export async function playerApi(ctx, req, res, query = {}) {
  const qs = new URLSearchParams({
    username: ctx.cred.username,
    password: ctx.cred.password,
  });
  for (const [k, v] of Object.entries(query)) {
    if (k === "username" || k === "password") continue;
    if (typeof v === "string" && k.length <= 50 && v.length <= 200)
      qs.set(k, v);
  }
  const url = `${ctx.cred.baseUrl}/player_api.php?${qs}`;
  if (ctx.mode === "redirect") return redirectTo(res, url);
  res.setHeader("Cache-Control", "no-store");
  // Só a resposta de autenticação (sem "action") é pequena e reescrita; as listas grandes passam em fluxo.
  return relay(req, res, url, {
    transform: query.action ? undefined : (buf) => rewriteAuthJson(buf, ctx),
    // Listas inteiras (get_live_streams etc.) têm dezenas de MB e o painel demora a começar a responder:
    // timeout maior e compressão em fluxo (o JSON encolhe ~10x até o navegador).
    ...(query.action ? { timeoutMs: 180_000, gzip: true } : {}),
    recheck: ctx.recheck,
  });
}

/** GET /get.php — playlist M3U do painel, com as URLs de mídia apontando para o espelho. */
export async function getPhp(ctx, req, res, query = {}) {
  const qs = new URLSearchParams({
    username: ctx.cred.username,
    password: ctx.cred.password,
  });
  for (const k of ["type", "output"])
    if (typeof query[k] === "string" && query[k].length <= 30)
      qs.set(k, query[k]);
  const url = `${ctx.cred.baseUrl}/get.php?${qs}`;
  if (ctx.mode === "redirect") return redirectTo(res, url);
  res.setHeader("Cache-Control", "no-store");
  return relay(req, res, url, {
    through: () =>
      m3uMirrorRewriter({
        username: ctx.cred.username,
        password: ctx.cred.password,
        base: ctx.publicBase,
        mirrorUser: ctx.token,
        mirrorPass: MIRROR_PASS,
      }),
    recheck: ctx.recheck,
  });
}

/** GET /xmltv.php — guia de programação (EPG). */
export async function xmltv(ctx, req, res) {
  const qs = new URLSearchParams({
    username: ctx.cred.username,
    password: ctx.cred.password,
  });
  const url = `${ctx.cred.baseUrl}/xmltv.php?${qs}`;
  if (ctx.mode === "redirect") return redirectTo(res, url);
  res.setHeader("Cache-Control", "no-store");
  return relay(req, res, url, { recheck: ctx.recheck });
}

/** GET /live|movie|series/:u/:p/:id.ext  (e /:u/:p/:id para canais ao vivo). */
export async function mediaStream(ctx, req, res, kind, file) {
  const m = String(file).match(/^(\d{1,12})(?:\.([A-Za-z0-9]{2,5}))?$/);
  if (!m || !["live", "movie", "series"].includes(kind))
    throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  const id = m[1];
  let ext = m[2]?.toLowerCase();
  if (kind === "live" && !ext) ext = "ts";
  console.log("==========================================================");
  console.log("");
  console.log(kind);
  console.log("");
  console.log("==========================================================");

  let url;
  try {
    // O painel informa onde os streams realmente ficam (server_info); pode ser outro host que o da API.
    url = await playUrlFor(accountOf(ctx.cred), { kind, id, ext });
  } catch {
    const u = encodeURIComponent(ctx.cred.username);
    const p = encodeURIComponent(ctx.cred.password);
    const e = kind === "live" ? (ext === "ts" ? "ts" : "m3u8") : (ext ?? "mp4");

    url = `${ctx.cred.baseUrl}/${kind === "live" ? "" : `${kind}/`}${u}/${p}/${id}.${e}`;
  }
  if (ctx.mode === "redirect") return redirectTo(res, url);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return relay(req, res, url, {
    stream: true,
    sessionKey: kind === "live" ? ctx.token : undefined,
    hlsWrap: hlsWrapFor(ctx),
    recheck: ctx.recheck,
  });
}

/** GET /hls/:token/:blob — segmentos e sub-playlists HLS (o alvo vem cifrado na URL gerada por nós, nunca do cliente). */
export async function hlsPart(ctx, req, res, blob) {
  let target;
  try {
    target = decryptSecret(blob);
  } catch {
    throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return relay(req, res, target, {
    hlsWrap: hlsWrapFor(ctx),
    recheck: ctx.recheck,
  });
}
