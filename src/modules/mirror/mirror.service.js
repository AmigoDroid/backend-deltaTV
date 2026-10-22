import { DeviceSession } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { verifyJwt } from "../../shared/crypto.js";
import { checkActivation, denialError } from "../access/access.service.js";
import { xtreamCredentialsOf } from "../xtream/xtream.service.js";
import { deliveryModeOf } from "./mode.js";

import { cachedMirrorAuth } from "./mirror.cache.js";

/** Consulta de verdade no banco: token "mirror" válido, sessão não revogada, licença/parceria liberada. */
async function loadAuth(token) {
  const payload = verifyJwt(token, "mirror");
  const session = await DeviceSession.findByPk(payload.sid);
  if (!session || session.revokedAt || session.activationId !== payload.aid || session.expiresAt < new Date()) {
    throw new AppError(401, "SESSION_REVOKED", "Sessão encerrada.");
  }
  const { activation, decision } = await checkActivation(payload.aid);
  if (!decision.allowed) throw denialError(decision);

  return {
    activationId: payload.aid,
    value: {
      token,
      mode: deliveryModeOf(activation),
      cred: await xtreamCredentialsOf(activation),
      publicBase: env.publicBaseUrl,
      // Revogação/bloqueio durante a transmissão: o relay consulta de tempos em tempos (direto no banco, sem cache)
      // e corta o stream.
      recheck: async () => {
        const s = await DeviceSession.findByPk(payload.sid);
        if (!s || s.revokedAt) return false;
        return (await checkActivation(payload.aid)).decision.allowed;
      },
    },
  };
}

/**
 * Autoriza uma requisição da rota espelho. O resultado (inclusive o modo proxy/redirect) fica em memória por
 * MIRROR_AUTH_CACHE_SECONDS: só a primeira requisição do token (e uma por TTL) vai ao banco.
 * O JWT é verificado a cada request (barato, sem banco), então token adulterado nunca chega ao cache.
 */
export async function authorizeMirror(token) {
  verifyJwt(token, "mirror");
  return cachedMirrorAuth(token, () => loadAuth(token), env.mirrorAuthCacheSeconds * 1000);
}
