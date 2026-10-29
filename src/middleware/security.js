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
    // Credenciais/tokens que viajam no caminho (JWT, blob cifrado do HLS) são mascarados.
    const safePath = req.originalUrl.split("?")[0]
      .replace(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, ":token")
      .replace(/\/_?hls\/.*$/, "/hls/:blob");
    console.log(`[${req.id}] ${req.method} ${safePath} ${res.statusCode} ${Date.now() - start}ms`);
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
// Rota espelho (players Xtream) e gateway de reprodução: playlists HLS geram requisições contínuas, por isso o limite
// é bem maior e é por credencial (token), não por IP (várias TVs atrás do mesmo NAT).
const JWT_SEG = /[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
export const mirrorLimiter = limiter(60_000, 3000, (req) => {
  const k = req.query?.username ?? req.query?.t ?? req.path.match(JWT_SEG)?.[0];
  return `mirror:${typeof k === "string" && k ? k.slice(-64) : req.ip}`;
});
export const loginLimiter = limiter(15 * 60_000, 10);
// Cadastro público de revendedor: poucas tentativas por hora por IP (cada uma gera um registro e um hash de senha).
export const signupLimiter = limiter(60 * 60_000, 5);
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
// Cadastro de lista por link (site público): cada tentativa pode consultar o provedor, então limita por IP e por MAC.
export const listUrlIpLimiter = limiter(15 * 60_000, 20);
export const listUrlMacLimiter = limiter(60 * 60_000, 15, (req) => `listurl:${String(req.body?.mac ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")}`);
export const pairingResolveLimiter = limiter(60_000, 30);
// Consulta/edição de dispositivo por MAC no painel do revendedor: por usuário (não por IP), contra varredura de MACs.
export const macLookupLimiter = limiter(60_000, 30, (req) => `maclookup:${req.user?.id ?? req.ip}`);
// Estoque de licenças: consulta de destinatário por e-mail (anti-enumeração) e escritas (transferir/aplicar), por usuário.
export const stockLookupLimiter = limiter(60_000, 10, (req) => `stocklookup:${req.user?.id ?? req.ip}`);
export const stockWriteLimiter = limiter(60_000, 20, (req) => `stockwrite:${req.user?.id ?? req.ip}`);
export const macWriteLimiter = limiter(60_000, 20, (req) => `macwrite:${req.user?.id ?? req.ip}`);
export const pairingPollLimiter = limiter(60_000, 60);
// Pix: gerar QR Code (cada um chama a API do provedor) e consultar o estado (polling da tela), por usuário.
export const pixCreateLimiter = limiter(60_000, 10, (req) => `pixcreate:${req.user?.id ?? req.ip}`);
export const pixReadLimiter = limiter(60_000, 60, (req) => `pixread:${req.user?.id ?? req.ip}`);
// Compra de licença pelo site (público, sem login): gerar QR chama a API do provedor; polling só consulta o nosso banco/provedor.
export const pixSiteCreateIpLimiter = limiter(15 * 60_000, 10);
export const pixSiteCreateMacLimiter = limiter(60 * 60_000, 8, (req) => `pixsite:${String(req.body?.mac ?? "").toUpperCase().replace(/[^0-9A-F]/g, "")}`);
export const pixSiteReadLimiter = limiter(60_000, 90);
// Cadastro de clientes do revendedor (criar/editar/renovar/excluir): por usuário.
// Ver usuário/senha da lista de um cliente: dado sensível, poucas consultas por minuto por usuário.
export const credentialsViewLimiter = limiter(60_000, 20, (req) => `credview:${req.user?.id ?? req.ip}`);
// Enviar e-mail em massa / teste: poucas vezes por minuto por usuário.
export const mailSendLimiter = limiter(60_000, 6, (req) => `mailsend:${req.user?.id ?? req.ip}`);
export const clientWriteLimiter = limiter(60_000, 60, (req) => `clientwrite:${req.user?.id ?? req.ip}`);
// Heartbeat de presença: poucas chamadas por TV (a cada ~30 s). Chave = token (várias TVs atrás do mesmo NAT não competem).
export const heartbeatLimiter = limiter(60_000, 20, (req) => {
  const bearer = (req.get("authorization") || "").slice(-64);
  return `hb:${bearer || req.ip}`;
});
