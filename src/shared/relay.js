import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";
import { safeGet } from "./ssrf.js";
import { isPlaylistHead, rewritePlaylist } from "../modules/sources/hls-rewrite.js";

/**
 * Núcleo de retransmissão (modo PROXY): o servidor busca o conteúdo na origem e entrega ao cliente.
 * Só usa objetos Node (req/res), sem depender do Express — por isso é testável com http.createServer.
 *
 *  - SSRF/DNS-rebinding: toda conexão sai por safeGet.
 *  - Range (filmes/séries com seek) e HEAD.
 *  - Playlist HLS: reescreve as URIs para o próprio servidor (opts.hlsWrap).
 *  - Resposta pequena em JSON/texto pode ser transformada em memória (opts.transform).
 *  - Streams longos disputam um limite de concorrência; revogação durante a transmissão corta o stream (opts.recheck).
 */

export const RELAY_UA = "Mozilla/5.0";
// Mesma estratégia do app Roku (RetryOtherUserAgent): se o painel recusar o UA (403/406), tenta VLC e depois sem UA.
const UA_CHAIN = [RELAY_UA, "VLC/3.0.18 LibVLC/3.0.18", null];
const RETRY_STATUS = new Set([403, 406]);
const RETRY_DELAY_MS = 450; // dá tempo de o painel liberar a conexão anterior (limite de conexões por usuário)
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_TRANSFORM_BYTES = 4 * 1024 * 1024;
const RECHECK_MS = 30_000;
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"];

let activeStreams = 0;
// Um stream "principal" por sessão: ao trocar de canal/filme, o anterior é cortado (libera a conexão no painel).
const mainStreams = new Map(); // sessionKey -> { cut() }

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

// URL segura para log: sem query string e sem credenciais/tokens no caminho.
const maskUrl = (u) => {
  try {
    const x = new URL(String(u));
    const path = x.pathname
      .replace(/^\/(live|movie|series)\/[^/]+\/[^/]+\//i, "/$1/***/***/") // /live/<user>/<senha>/<id>.ext
      .replace(/^\/[^/]+\/[^/]+\/(\d+(?:\.\w+)?)$/, "/***/***/$1") // formato curto /<user>/<senha>/<id>
      .replace(/^\/hls\/[^/]+/i, "/hls/***") // /hls/<token>/...
      .split("/")
      .map((seg) => (seg.length > 24 ? "***" : seg)) // qualquer outro segmento longo pode ser token
      .join("/");
    return `${x.origin}${path}`;
  } catch {
    return "(url inválida)";
  }
};

// Último User-Agent que a origem aceitou, por host: evita repetir tentativas que já sabemos que falham.
const uaPref = new Map(); // host -> índice em UA_CHAIN

// Primeiros bytes do corpo de uma resposta de erro da origem (para diagnóstico em log). Nunca vai ao cliente.
async function peekBody(up, max = 300, waitMs = 1500) {
  const chunks = [];
  let n = 0;
  const read = (async () => {
    try {
      for await (const c of up) {
        chunks.push(c);
        n += c.length;
        if (n >= max) break;
      }
    } catch { /* ignora */ }
  })();
  await Promise.race([read, new Promise((r) => setTimeout(r, waitMs))]);
  up.destroy();
  return Buffer.concat(chunks).toString("utf8", 0, max).replace(/\s+/g, " ").trim();
}

/** Abre a origem; em 403/406 repete com outro User-Agent e, por fim, sem `Range: bytes=0-`. */
async function openUpstream(req, target, signal, timeoutMs) {
  const range = req.headers.range;
  let host = "";
  try { host = new URL(target).host; } catch { /* safeGet rejeita */ }
  const first = uaPref.get(host) ?? 0;
  const order = [first, ...UA_CHAIN.map((_, i) => i).filter((i) => i !== first)];
  const attempts = order.map((i) => ({ i, ua: UA_CHAIN[i], range }));
  if (range && /^bytes=0-$/.test(range.trim())) attempts.push({ i: first, ua: UA_CHAIN[first], range: undefined });
  let up;
  for (let n = 0; n < attempts.length; n++) {
    const { i, ua, range: r } = attempts[n];
    const headers = { accept: "*/*" };
    if (ua) headers["user-agent"] = ua;
    if (r) headers.range = r;
    up = await safeGet(target, { headers, signal, ...(timeoutMs ? { timeoutMs } : {}) });
    const refused = RETRY_STATUS.has(up.statusCode);
    if (!refused) {
      if (n > 0 && up.statusCode < 400) {
        if (r === range) uaPref.set(host, i); // só memoriza quando o que mudou foi o UA, não o Range
        console.info(`[relay] origem aceitou na tentativa ${n + 1} (ua=${ua ?? "nenhum"}, range=${r ?? "-"}) host=${host}`);
      }
      return up;
    }
    if (n === attempts.length - 1) return up;
    up.resume();
    await sleep(RETRY_DELAY_MS, signal);
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }
  return up;
}
export const relayStats = () => ({ activeStreams });

const originError = (e) =>
  e instanceof AppError ? e : new AppError(502, "ORIGIN_UNAVAILABLE", "Não foi possível acessar a origem.");

async function readAll(it, first, limit, tooBig) {
  const parts = [first];
  let size = first.length;
  for (;;) {
    const n = await it.next();
    if (n.done) break;
    size += n.value.length;
    if (size > limit) throw tooBig;
    parts.push(n.value);
  }
  return Buffer.concat(parts);
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} target  URL de origem (com credenciais; nunca sai do servidor)
 * @param {object} [opts]
 * @param {boolean} [opts.stream=false]       conta no limite de streams simultâneos (vídeo/áudio longos)
 * @param {(abs:string)=>string} [opts.hlsWrap]  reescreve playlists HLS (devolve a URI do servidor para a URL absoluta)
 * @param {(body:Buffer, upstream:object)=>Buffer|string|null} [opts.transform]  transforma a resposta 200 inteira (pequena)
 * @param {()=>import("node:stream").Transform} [opts.through]  passa o corpo (em fluxo) por um Transform; o tamanho final muda
 * @param {string} [opts.sessionKey]  com `stream`, só um stream principal por sessão: o novo corta o anterior
 * @param {()=>Promise<boolean>} [opts.recheck]  reavalia o acesso periodicamente; false corta o stream
 * @param {number} [opts.timeoutMs]  tempo máximo sem receber dados da origem (padrão 20 s). Listas inteiras do painel
 *                                   (dezenas de MB) demoram para começar a responder.
 * @param {boolean} [opts.gzip]  comprime em fluxo (gzip) quando o cliente aceita: JSON de listas encolhe ~10x
 */
export async function relay(req, res, target, opts = {}) {
  const { stream = false, hlsWrap, transform, through, recheck, sessionKey, timeoutMs, gzip = false } = opts;
  if (stream && env.proxyMaxConcurrent > 0 && activeStreams >= env.proxyMaxConcurrent) {
    throw new AppError(503, "PROXY_BUSY", "Capacidade de retransmissão esgotada.");
  }
  if (stream) activeStreams++;

  const ac = new AbortController();
  let timer;
  let mine;
  // Só navegadores (enviam Sec-Fetch-*; o Roku e outros players nativos não). O UA não serve de critério:
  // o Roku troca o próprio User-Agent em alguns casos (PlayerScreen.brs).
  const isBrowser = typeof req.headers["sec-fetch-mode"] === "string";
  if (stream && sessionKey && isBrowser) {
    mainStreams.get(sessionKey)?.cut();
    mine = { cut: () => { ac.abort(); if (!res.writableEnded) res.destroy(); } };
    mainStreams.set(sessionKey, mine);
  }
  try {
    let upstream;
    try {
      upstream = await openUpstream(req, target, ac.signal, timeoutMs);
    } catch (e) {
      if (e?.name === "AbortError") return;
      throw originError(e);
    }
    res.once("close", () => {
      ac.abort();
      upstream.destroy();
    });

    const status = upstream.statusCode;
    if (status >= 400 && status !== 416) {
      const hint = await peekBody(upstream);
      const via = [upstream.headers.server, upstream.headers["cf-ray"] && "cloudflare"].filter(Boolean).join("/") || "-";
      console.warn(`[relay] origem respondeu ${status} para ${maskUrl(target)} (range=${req.headers.range ?? "-"}, via=${via}) corpo="${hint}"`);
      if (status === 404) throw new AppError(404, "NOT_FOUND", "Conteúdo não encontrado na origem.");
      throw new AppError(502, "ORIGIN_ERROR", "A origem não respondeu corretamente.", { upstreamStatus: status });
    }

    const ct = String(upstream.headers["content-type"] || "");
    const isMedia = /^(video|audio)\//i.test(ct);
    const finalUrl = upstream.finalUrl || target;
    const wantsHls = !!hlsWrap && status === 200 && !req.headers.range && !isMedia;
    const wantsTransform = !!transform && status === 200;

    let body = upstream;
    if (wantsHls || wantsTransform) {
      const it = upstream[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done) {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (wantsHls && isPlaylistHead(first.value)) {
        const buf = await readAll(it, first.value, MAX_PLAYLIST_BYTES, new AppError(502, "PLAYLIST_TOO_LARGE", "Playlist da origem grande demais."));
        const text = rewritePlaylist(buf.toString("utf8"), finalUrl, hlsWrap);
        res.statusCode = 200;
        res.setHeader("content-type", "application/vnd.apple.mpegurl");
        res.setHeader("content-length", Buffer.byteLength(text));
        res.end(req.method === "HEAD" ? undefined : text);
        return;
      }
      if (wantsTransform) {
        const buf = await readAll(it, first.value, MAX_TRANSFORM_BYTES, new AppError(502, "ORIGIN_TOO_LARGE", "Resposta da origem grande demais."));
        let out = null;
        try {
          out = transform(buf, upstream);
        } catch {
          out = null; // não conseguiu interpretar: entrega como veio
        }
        const data = out == null ? buf : Buffer.from(out);
        res.statusCode = 200;
        if (ct) res.setHeader("content-type", ct);
        res.setHeader("content-length", data.length);
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      // Não era playlist: devolve o primeiro pedaço e segue com o resto do stream.
      body = Readable.from(
        (async function* () {
          yield first.value;
          for (;;) {
            const n = await it.next();
            if (n.done) return;
            yield n.value;
          }
        })(),
      );
    }

    res.statusCode = status;
    for (const h of PASS_HEADERS) if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    if (through && status === 200) {
      const t = through();
      upstream.on("error", (e) => t.destroy(e));
      body = upstream.pipe(t);
      res.removeHeader("content-length");
    }

    if (req.method === "HEAD") {
      upstream.destroy();
      res.end();
      return;
    }
    if (
      gzip && status === 200 && !req.headers.range && !upstream.headers["content-encoding"] &&
      /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""))
    ) {
      const gz = zlib.createGzip({ level: 6 });
      upstream.on("error", (e) => gz.destroy(e));
      body = body.pipe(gz);
      res.setHeader("content-encoding", "gzip");
      res.setHeader("vary", "Accept-Encoding");
      res.removeHeader("content-length");
    }
    if (recheck) {
      timer = setInterval(async () => {
        try {
          if (!(await recheck())) {
            ac.abort();
            upstream.destroy();
            res.destroy();
          }
        } catch {
          /* mantém o stream; tenta no próximo ciclo */
        }
      }, RECHECK_MS);
    }
    await pipeline(body, res);
  } catch (e) {
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.name === "AbortError") return;
    if (!res.headersSent) throw e;
    res.destroy();
  } finally {
    clearInterval(timer);
    if (mine && mainStreams.get(sessionKey) === mine) mainStreams.delete(sessionKey);
    if (stream) activeStreams--;
  }
}
