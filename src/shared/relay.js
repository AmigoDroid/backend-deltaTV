import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
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
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_TRANSFORM_BYTES = 4 * 1024 * 1024;
const RECHECK_MS = 30_000;
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition"];

let activeStreams = 0;
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
 * @param {()=>Promise<boolean>} [opts.recheck]  reavalia o acesso periodicamente; false corta o stream
 */
export async function relay(req, res, target, opts = {}) {
  const { stream = false, hlsWrap, transform, through, recheck } = opts;
  if (stream && env.proxyMaxConcurrent > 0 && activeStreams >= env.proxyMaxConcurrent) {
    throw new AppError(503, "PROXY_BUSY", "Capacidade de retransmissão esgotada.");
  }
  if (stream) activeStreams++;

  const ac = new AbortController();
  let timer;
  try {
    const headers = { "user-agent": RELAY_UA, accept: "*/*" };
    if (req.headers.range) headers.range = req.headers.range;

    let upstream;
    try {
      upstream = await safeGet(target, { headers, signal: ac.signal });
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
      upstream.resume();
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
    if (stream) activeStreams--;
  }
}
