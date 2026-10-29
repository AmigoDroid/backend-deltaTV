import { DeviceSession } from "../../db/models/index.js";
import { verifyJwt } from "../../shared/crypto.js";
import { AppError } from "../../shared/errors.js";
import { checkActivation, denialError } from "./access.service.js";
import { touchDevice } from "../devices/presence.js";

/**
 * Gate de acesso do dispositivo (autorização no BACKEND, a cada requisição).
 *  typ "device": token no header Authorization (API do cliente)
 *  typ "play":   token curto em ?t= (URLs de reprodução; players não enviam headers)
 * enforce=false: autentica o token, mas devolve a decisão em vez de negar (endpoints de status).
 */
export const requireDevice = (typ = "device", { enforce = true, graceSeconds = 0 } = {}) => async (req, _res, next) => {
  let token;
  if (typ === "play") token = typeof req.query.t === "string" ? req.query.t : null;
  else token = (req.get("authorization") || "").startsWith("Bearer ") ? req.get("authorization").slice(7) : null;

  const payload = verifyJwt(token, typ, { graceSeconds });
  const session = await DeviceSession.findByPk(payload.sid);
  if (!session || session.revokedAt || session.activationId !== payload.aid) {
    throw new AppError(401, "SESSION_REVOKED", "Sessão encerrada.");
  }
  const { activation, decision } = await checkActivation(payload.aid);
  // Sinal de vida (só memória): vale mesmo que o acesso esteja negado — o aparelho está falando com o servidor.
  touchDevice(activation?.deviceId);
  if (enforce && !decision.allowed) throw denialError(decision);
  req.device = { activation, decision, session };
  next();
};
