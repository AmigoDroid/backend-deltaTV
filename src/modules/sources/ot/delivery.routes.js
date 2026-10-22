import { Router } from "express";
import { pipeline } from "node:stream/promises";
import net from "node:net";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { parseHttpUrl, isPrivateAddress, safeGet } from "../../shared/ssrf.js";
import { requireDevice } from "../access/access.middleware.js";
import { checkActivation } from "../access/access.service.js";
import {
  isHlsResponse,
  looksLikePlaylist,
  readPlaylistText,
  rewritePlaylist,
  segmentUrlFactory,
} from "./hls-rewrite.js";
import {
  PERSONAL,
  getAllowedSource,
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

// Segmentos/sub-playlists HLS cujas URLs foram reescritas pelo gateway (ver hls-rewrite.js).
// O token ?t= é assinado por nós e carrega a URL real do provedor; o acesso do dispositivo
// é revalidado no banco a cada requisição, como nas demais rotas de reprodução.
router.get("/seg", requireDevice("seg"), async (req, res) => {
  const { activation, payload } = req.device;
  if (typeof payload?.u !== "string") {
    throw new AppError(400, "INVALID_SEGMENT", "Segmento inválido.");
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return proxyStream(req, res, payload.u, activation.id, { segment: true });
});

router.get("/:sourceId/:ref", requireDevice("play"), async (req, res) => {
  const { activation } = req.device;
  const ref = req.params.ref.replace(/\.[A-Za-z0-9]{2,5}$/, ""); // remove a extensão-dica (.ts, .m3u8...)
  let target;
  let deliveryMode;
  if (req.params.sourceId === PERSONAL) {
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
    return proxyStream(req, res, target, activation.id);

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

async function proxyStream(req, res, target, activationId, { segment = false } = {}) {
  // Segmentos HLS são requisições curtas e frequentes: não disputam o limite de streams longos.
  if (!segment) {
    if (activeProxies >= env.proxyMaxConcurrent)
      throw new AppError(
        503,
        "PROXY_BUSY",
        "Capacidade de retransmissão esgotada.",
      );
    activeProxies++;
  }
  const ac = new AbortController();
  let timer;
  try {
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    const upstream = await safeGet(target, { headers, signal: ac.signal });

    // Playlist HLS: reescreve as URIs (segmentos, chaves, variantes) para passarem pelo
    // gateway. Os caminhos relativos do provedor ("/hls/...") não funcionam no host do gateway.
    const finalUrl = upstream.finalUrl || target;
    if (upstream.statusCode === 200 && isHlsResponse(upstream.headers, finalUrl)) {
      const text = await readPlaylistText(upstream);
      const body = looksLikePlaylist(text)
        ? rewritePlaylist(
            text,
            finalUrl,
            segmentUrlFactory({
              activationId: req.device.activation.id,
              sessionId: req.device.session.id,
            }),
          )
        : text;
      res.status(200);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.setHeader("Content-Length", Buffer.byteLength(body));
      res.end(body);
      return;
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
    await pipeline(upstream, res);
  } catch (e) {
    if (e?.code === "ERR_STREAM_PREMATURE_CLOSE" || e?.name === "AbortError")
      return;
    if (!res.headersSent) throw e;
    res.destroy();
  } finally {
    clearInterval(timer);
    if (!segment) activeProxies--;
  }
}

export default router;
