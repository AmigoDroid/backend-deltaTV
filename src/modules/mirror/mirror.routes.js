import { Router } from "express";
import { AppError } from "../../shared/errors.js";
import { mirrorLimiter } from "../../middleware/security.js";
import { authorizeMirror } from "./mirror.service.js";
import * as H from "./mirror.handlers.js";

/**
 * Rota espelho do painel Xtream. Montada na RAIZ: o app usa a URL pública deste servidor como se fosse o painel.
 *
 *   GET /player_api.php?username=<token>&password=*[&action=...]
 *   GET /get.php?username=<token>&password=*[&type=m3u_plus&output=ts]
 *   GET /xmltv.php?username=<token>&password=*
 *   GET /live|movie|series/<token>/*\/<id>.<ext>     e     GET /<token>/*\/<id>   (ao vivo)
 *   GET /hls/<token>/<blob>                         (segmentos/sub-playlists HLS reescritos pelo servidor)
 *
 * "username" é o token de espelho (POST /api/v1/client/xtream devolve já pronto); a senha é ignorada.
 * Proxy x redirect: definido pelo provedor da parceria (deliveryMode) — ver mode.js.
 */
const router = Router();

const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const str = (v) => (typeof v === "string" ? v : null);
const NOCACHE = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
// Montado na raiz: o limitador e o no-store valem SÓ para estas rotas, nunca para o resto da API.
const guard = [mirrorLimiter, NOCACHE];

// Com credencial inválida, o painel Xtream real responde 200 com auth=0 — os players entendem isso como "login recusado".
function authFailure(res, err) {
  res.status(200).json({ user_info: { auth: 0, status: "Disabled", message: err.message, code: err.code } });
}

router.get("/player_api.php", ...guard, async (req, res) => {
  let ctx;
  try {
    ctx = await authorizeMirror(str(req.query.username));
  } catch (e) {
    if (e instanceof AppError && [401, 403, 422, 503].includes(e.status)) {
      // Sem "action" (login do player): 200 + auth=0, como o painel real. Com "action" um objeto no lugar da lista seria
      // lido como lista vazia; por isso vai o status HTTP de erro, que o app trata como falha.
      return req.query.action ? res.status(e.status === 503 ? 503 : 401).json({ code: e.code, message: e.message }) : authFailure(res, e);
    }
    throw e;
  }
  return H.playerApi(ctx, req, res, req.query);
});

router.get("/get.php", ...guard, async (req, res) => H.getPhp(await authorizeMirror(str(req.query.username)), req, res, req.query));
router.get("/xmltv.php", ...guard, async (req, res) => H.xmltv(await authorizeMirror(str(req.query.username)), req, res));

router.get("/hls/:u/:blob", ...guard, async (req, res, next) => {
  if (!JWT_RE.test(req.params.u)) return next();
  return H.hlsPart(await authorizeMirror(req.params.u), req, res, req.params.blob);
});

// (Express 5 não aceita regex em parâmetros: uma rota por tipo.)
for (const kind of ["live", "movie", "series"]) {
  router.get(`/${kind}/:u/:p/:file`, ...guard, async (req, res) =>
    H.mediaStream(await authorizeMirror(req.params.u), req, res, kind, req.params.file));
}

// Formato curto do Xtream para canal ao vivo: /usuario/senha/<id>[.ext]. Só casa com token JWT + id numérico.
router.get("/:u/:p/:file", (req, res, next) => {
  // Só entra no limitador/handler se parecer espelho; o resto segue para as demais rotas.
  if (!JWT_RE.test(req.params.u) || !/^\d{1,12}(\.[A-Za-z0-9]{2,5})?$/.test(req.params.file)) return next("route");
  next();
}, ...guard, async (req, res) => {
  return H.mediaStream(await authorizeMirror(req.params.u), req, res, "live", req.params.file);
});

export default router;
