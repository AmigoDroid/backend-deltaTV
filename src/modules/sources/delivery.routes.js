import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import net from "node:net";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { parseHttpUrl, isPrivateAddress, safeGet } from "../../shared/ssrf.js";
import { requireDevice } from "../access/access.middleware.js";
import { checkActivation } from "../access/access.service.js";
import { decryptSecret, encryptSecret } from "../../shared/crypto.js";
import { isPlaylistHead, rewritePlaylist } from "./hls-rewrite.js";
import { liveVariantOrigin } from "./live-variant.js";
import { repo as catalogRepo } from "../catalog/catalog.runtime.js";
import { resolvePlayable, isUuid } from "../catalog/query.service.js";
import { isXtreamId, resolvePlayable as resolveXtreamPlayable } from "../xtream/xtream.catalog.js";
import { xtreamAccountOf } from "../xtream/xtream.client.js";
import {
  PERSONAL,
  getAllowedSource,
  hasPersonalPlaylist,
  resolveOrigin,
  resolvePersonalOrigin,
  signedOrigin,
} from "./sources.service.js";

/**
 * Gateway de autorização: a cada acesso (re)valida o dispositivo no banco e só então
 *  - redireciona (302) para a origem (padrão; não consome banda do servidor), ou
 *  - faz proxy (opcional por fonte, com limite de concorrência e recheck periódico de acesso).
 * Se a origem não suporta URLs assinadas, uma URL já entregue continua válida na origem
 * até ela mesma revogá-la — o bloqueio aqui impede novas URLs, não anula o que já foi entregue.
 */
const router = Router();
let activeProxies = 0;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;

router.get("/:sourceId/:ref", requireDevice("play"), async (req, res) => {
  const { activation } = req.device;
  const ref = req.params.ref.replace(/\.[A-Za-z0-9]{2,5}$/, ""); // remove a extensão-dica (.ts, .m3u8...)
  // A extensão-dica também escolhe a variante de um canal ao vivo (HLS x MPEG-TS), ver live-variant.js.
  const hint = (req.params.ref.match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? "").toLowerCase();
  let target;
  let deliveryMode;
  if (isXtreamId(ref)) {
    // Catálogo sob demanda (painel Xtream): a origem é montada aqui, com as credenciais da própria ativação.
    if (req.params.sourceId !== PERSONAL) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    const account = await xtreamAccountOf(activation);
    if (!account) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    const row = await resolveXtreamPlayable({ account, id: ref, hint });
    if (!row) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    target = row.origin;
    deliveryMode = "proxy";
  } else if (isUuid(ref)) {
    // Catálogo persistente: o id é estável e a origem (cifrada) só existe no servidor. A autorização da lista é a mesma de antes.
    const personal = req.params.sourceId === PERSONAL;
    const source = personal
      ? null
      : await getAllowedSource(activation, req.params.sourceId);
    const scope = personal
      ? { type: "activation", id: activation.id }
      : { type: "source", id: source.id };
    const row = await resolvePlayable({ repo: catalogRepo, scope, id: ref });
    if (!row) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    let origin = decryptSecret(row.originEnc);
    if (row.kind === "live") origin = liveVariantOrigin(origin, hint);
    target = personal ? origin : signedOrigin(source, origin);
    deliveryMode = personal ? "proxy" : source.deliveryMode;
  } else if (req.params.sourceId === PERSONAL) {
    // Playlist do próprio cliente (servidor do provedor da parceria + credenciais guardadas cifradas).
    const r = await resolvePersonalOrigin(activation, ref);
    target = r.origin;
    deliveryMode = r.deliveryMode;
  } else {
    const source = await getAllowedSource(activation, req.params.sourceId);
    target = signedOrigin(source, await resolveOrigin(source, ref));
    deliveryMode = source.deliveryMode;
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer"); // não vaza o token de reprodução para a origem

  if (deliveryMode === "proxy")
    return proxyStream(req, res, target, activation.id, hlsCtx(req));

  const url = parseHttpUrl(target);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !env.allowPrivateSources &&
    (host === "localhost" || (net.isIP(host) && isPrivateAddress(host)))
  ) {
    throw new AppError(502, "ORIGIN_NOT_ALLOWED", "Origem não permitida.");
  }
  return res.redirect(302, url.href);
});

// Segmentos / sub-playlists HLS: o alvo vem cifrado na própria URL (gerado por rewritePlaylist), nunca do cliente.
// O token de reprodução dura poucos minutos, mas uma playlist HLS AO VIVO é relida o tempo todo (e cada segmento
// carrega o mesmo ?t=). Sem tolerância o canal morre quando o token vence. A sessão e a ativação continuam sendo
// revalidadas no banco a cada requisição (revogação/bloqueio valem na hora); só o relógio do token é relaxado.
router.get("/:sourceId/_hls/:blob", requireDevice("play", { graceSeconds: env.hlsTokenGraceSeconds }), async (req, res) => {
  const { activation } = req.device;
  if (req.params.sourceId === PERSONAL) {
    if (!hasPersonalPlaylist(activation))
      throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  } else {
    await getAllowedSource(activation, req.params.sourceId); // 404 se a lista não for autorizada
  }
  let target;
  try {
    target = decryptSecret(req.params.blob);
  } catch {
    throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return proxyStream(req, res, target, activation.id, hlsCtx(req));
});

const hlsCtx = (req) => ({
  sourceId: req.params.sourceId,
  token: typeof req.query.t === "string" ? req.query.t : "",
});

async function proxyStream(req, res, target, activationId, ctx) {
  if (env.proxyMaxConcurrent > 0 && activeProxies >= env.proxyMaxConcurrent)
    throw new AppError(
      503,
      "PROXY_BUSY",
      "Capacidade de retransmissão esgotada.",
    );
  activeProxies++;
  const ac = new AbortController();
  let timer;
  try {
    // Sem User-Agent muitos painéis respondem 403; mesmo UA do relay do espelho.
    const headers = { "user-agent": "Mozilla/5.0", accept: "*/*" };
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = await safeGet(target, { headers, signal: ac.signal });

    // HLS: se a origem devolveu uma playlist, reescreve as URIs para o gateway (ver hls-rewrite.js).
    // Só inspeciona quando não é claramente mídia (video/*, audio/*) nem Range; streams contínuos (MPEG-TS) seguem direto.
    let body = upstream;
    const ct = String(upstream.headers["content-type"] || "");
    const inspect =
      upstream.statusCode === 200 &&
      !req.headers.range &&
      !/^(video|audio)\//i.test(ct);
    if (inspect) {
      const it = upstream[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done) {
        res.status(200);
        return res.end();
      }
      if (isPlaylistHead(first.value)) {
        const parts = [first.value];
        let size = first.value.length;
        for (;;) {
          const n = await it.next();
          if (n.done) break;
          size += n.value.length;
          if (size > MAX_PLAYLIST_BYTES)
            throw new AppError(
              502,
              "PLAYLIST_TOO_LARGE",
              "Playlist da origem grande demais.",
            );
          parts.push(n.value);
        }
        const base = upstream.finalUrl || target;
        const wrap = (abs) =>
          `/api/v1/play/${ctx.sourceId}/_hls/${encryptSecret(abs)}?t=${encodeURIComponent(ctx.token)}`;
        const text = rewritePlaylist(
          Buffer.concat(parts).toString("utf8"),
          base,
          wrap,
        );
        res.status(200);
        res.setHeader("content-type", "application/vnd.apple.mpegurl");
        return res.send(text);
      }
      // não é playlist: devolve o primeiro pedaço e segue com o resto do stream
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

    res.status(upstream.statusCode);
    for (const h of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ]) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    // Revogação durante a transmissão: reavalia o acesso periodicamente e corta o stream.
    timer = setInterval(async () => {
      try {
        const { decision } = await checkActivation(activationId);
        if (!decision.allowed) {
          ac.abort();
          upstream.destroy();
          res.destroy();
        }
      } catch {
        /* mantém o stream; tenta no próximo ciclo */
      }
    }, 30_000);
    res.on("close", () => ac.abort());
    await pipeline(body, res);
  } catch (e) {
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.name === "AbortError")
      return;
    if (!res.headersSent) throw e;
    res.destroy();
  } finally {
    clearInterval(timer);
    activeProxies--;
  }
}

export default router;
