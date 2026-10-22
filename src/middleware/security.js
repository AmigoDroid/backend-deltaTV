import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { AppError } from "../shared/errors.js";
import { env } from "../config/env.js";

export function requestContext(req, res, next) {
  req.id = crypto.randomUUID();
  res.setHeader("X-Request-Id", req.id);
  const start = Date.now();
  res.on("finish", () => {
    // Loga só o caminho (a query pode conter tokens de reprodução).
    console.log(`[${req.id}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
}

const limiter = (windowMs, limit, keyGenerator) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => env.rateLimitDisabled,
    ...(keyGenerator ? { keyGenerator, validate: false } : {}),
    handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Muitas requisições. Aguarde e tente novamente.")),
  });

export const apiLimiter = limiter(60_000, 600);
export const loginLimiter = limiter(15 * 60_000, 10);
// Ativação: limita por IP e também por MAC (impede varredura de códigos por dispositivo).
export const activationIpLimiter = limiter(15 * 60_000, 30);
export const activationMacLimiter = limiter(15 * 60_000, 10, (req) => `mac:${String(req.body?.mac ?? "").toUpperCase()}:${req.ip}`);
// Ativação de parceria testa usuário/senha no servidor do provedor: limita por código+IP e por código+usuário,
// para o endpoint não virar uma ferramenta de força bruta contra contas do parceiro.
export const partnerCodeIpLimiter = limiter(15 * 60_000, 20, (req) => `pc:${String(req.body?.code ?? "").toUpperCase()}:${req.ip}`);
export const partnerCredLimiter = limiter(15 * 60_000, 8, (req) => `pu:${String(req.body?.code ?? "").toUpperCase()}:${String(req.body?.username ?? "").toLowerCase()}`);
export const codeCheckLimiter = limiter(60_000, 30);
export const refreshLimiter = limiter(60_000, 60);
export const webhookLimiter = limiter(60_000, 120);
export const deviceRegistrationLimiter = limiter(15 * 60_000, 20);
// Recuperação por MAC: poucas por hora por MAC (evita que alguém fique derrubando a sessão de uma TV).
export const registerMacLimiter = limiter(60 * 60_000, 12, (req) => `regmac:${String(req.body?.mac ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")}`);
// Login por chave de 6 dígitos: por IP e por MAC (a chave também se invalida após 5 erros).
export const deviceKeyIpLimiter = limiter(15 * 60_000, 20);
export const deviceKeyMacLimiter = limiter(15 * 60_000, 10, (req) => `dkey:${String(req.body?.mac ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")}`);
export const deviceKeyIssueLimiter = limiter(60 * 60_000, 10, (req) => `dkeyissue:${req.device?.activation?.id ?? req.ip}`);
export const pairingResolveLimiter = limiter(60_000, 30);
// Consulta/edição de dispositivo por MAC no painel do revendedor: por usuário (não por IP), contra varredura de MACs.
export const macLookupLimiter = limiter(60_000, 30, (req) => `maclookup:${req.user?.id ?? req.ip}`);
export const macWriteLimiter = limiter(60_000, 20, (req) => `macwrite:${req.user?.id ?? req.ip}`);
export const pairingPollLimiter = limiter(60_000, 60);
