import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const e = process.env;
const nodeEnv = e.NODE_ENV || "development";
const isProd = nodeEnv === "production";
import dotenv from "dotenv";
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

function required(name, devDefault) {
  const value = e[name];
  if (value) return value;
  if (isProd)
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return devDefault; // valores de desenvolvimento NUNCA são aceitos em produção
}

const int = (name, def) => {
  const n = Number.parseInt(e[name] ?? "", 10);
  return Number.isFinite(n) ? n : def;
};

const encryptionKey = Buffer.from(
  required(
    "ENCRYPTION_KEY",
    crypto.createHash("sha256").update("dev-only-key").digest("base64"),
  ),
  "base64",
);
if (encryptionKey.length !== 32) {
  throw new Error("ENCRYPTION_KEY deve ser uma chave de 32 bytes em base64.");
}
const jwtSecret = required(
  "JWT_SECRET",
  "dev-only-jwt-secret-change-me-0123456789",
);
if (isProd && jwtSecret.length < 32)
  throw new Error("JWT_SECRET deve ter ao menos 32 caracteres.");
const publicBaseUrl = (e.PUBLIC_BASE_URL || `http://localhost:${int("PORT", 3000)}`).replace(/\/+$/, "");
let publicBase;
try {
  publicBase = new URL(publicBaseUrl);
} catch {
  throw new Error("PUBLIC_BASE_URL deve ser uma URL HTTP(S) absoluta.");
}
if (!["http:", "https:"].includes(publicBase.protocol) || (isProd && publicBase.protocol !== "https:")) {
  throw new Error("PUBLIC_BASE_URL deve usar HTTPS em produção.");
}
if (publicBase.username || publicBase.password || publicBase.pathname !== "/" || publicBase.search || publicBase.hash) {
  throw new Error("PUBLIC_BASE_URL deve conter somente a origem pública do serviço.");
}
if (isProd && !e.PUBLIC_BASE_URL) {
  throw new Error("Variável de ambiente obrigatória ausente: PUBLIC_BASE_URL");
}

const mailPort = int("SMTP_PORT", 587);
const mailSecure = e.SMTP_SECURE ? e.SMTP_SECURE === "true" : mailPort === 465;
const mailUser = (e.SMTP_USER || "").trim();
const mailHost = (e.SMTP_HOST || "").trim();
const mailFrom = (e.MAIL_FROM || "").trim();
if (mailHost && !mailFrom) throw new Error('MAIL_FROM é obrigatório quando SMTP_HOST está definido (ex.: "DeltaTV <no-reply@seudominio.com>").');
if (mailFrom && /[\r\n]/.test(mailFrom)) throw new Error("MAIL_FROM inválido.");
const mailBrand = (e.MAIL_BRAND || "DeltaTV").trim();
const mailConfig = Object.freeze({
  host: mailHost, port: mailPort, secure: mailSecure, user: mailUser, pass: e.SMTP_PASS || "",
  // Com login, exige STARTTLS (a senha não vai em texto puro). Só desligue em laboratório.
  requireTls: e.SMTP_REQUIRE_TLS ? e.SMTP_REQUIRE_TLS === "true" : !mailSecure && !!mailUser,
  from: mailFrom, replyTo: (e.MAIL_REPLY_TO || "").trim(), brand: mailBrand,
  footer: e.MAIL_FOOTER ?? `${mailBrand} · Você recebeu este e-mail por ser cliente ou parceiro. Para deixar de receber, responda pedindo a remoção.`,
  ratePerMinute: Math.max(1, int("MAIL_RATE_PER_MINUTE", 30)), maxRecipients: Math.max(1, int("MAIL_MAX_RECIPIENTS", 2000)),
  configured: !!mailHost && !!mailFrom,
});

// Pix: "" (desligado), "mercadopago" (produção) ou "mock" (só desenvolvimento: o admin simula o pagamento).
const pixProvider = (e.PIX_PROVIDER || "").trim().toLowerCase();
if (pixProvider && !["mercadopago", "mock"].includes(pixProvider)) {
  throw new Error('PIX_PROVIDER deve ser "mercadopago", "mock" ou vazio (desligado).');
}
if (pixProvider === "mock" && isProd) throw new Error('PIX_PROVIDER=mock não é permitido em produção.');
if (pixProvider === "mercadopago" && !e.MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN é obrigatório com PIX_PROVIDER=mercadopago.");
if (pixProvider === "mercadopago" && isProd && !e.MP_WEBHOOK_SECRET) {
  throw new Error("MP_WEBHOOK_SECRET é obrigatório em produção com PIX_PROVIDER=mercadopago (assinatura do webhook).");
}

export const env = Object.freeze({
  pixProvider,
  mpAccessToken: e.MP_ACCESS_TOKEN || "",
  mpWebhookSecret: e.MP_WEBHOOK_SECRET || "",
  // Validade do QR Code (o Mercado Pago aceita de 30 min a 30 dias).
  pixExpirationMinutes: Math.min(Math.max(int("PIX_EXPIRATION_MINUTES", 60), 30), 43200),
  nodeEnv,
  isProd,
  port: int("PORT", 3000),
  trustProxy: e.TRUST_PROXY === "true" ? true : int("TRUST_PROXY", 0),
  corsOrigins: (e.CORS_ORIGINS || "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://postgres:postgres@localhost:5432/iptv_licensing",
  ),
  dbSsl: e.DB_SSL === "true",
  dbSslStrict: e.DB_SSL_STRICT !== "false",
  jwtSecret,
  codePepper: required("CODE_PEPPER", "dev-only-pepper-change-me-0123456789"),
  webhookSecret: required("WEBHOOK_SECRET", "dev-only-webhook-secret"),
  encryptionKey,
  adminAccessTtl: int("ACCESS_TOKEN_TTL_SECONDS", 900),
  adminRefreshTtlDays: int("ADMIN_REFRESH_TTL_DAYS", 7),
  deviceAccessTtl: int("DEVICE_ACCESS_TTL_SECONDS", 600),
  deviceRefreshTtlDays: int("DEVICE_REFRESH_TTL_DAYS", 30),
  playTokenTtl: int("PLAY_TOKEN_TTL_SECONDS", 600),
  // Tolerância do relógio do token de reprodução nos segmentos/playlists HLS (/play/:lista/_hls/*): canal ao vivo
  // precisa continuar tocando depois do vencimento do token (6 h por padrão; a revogação da sessão continua imediata).
  hlsTokenGraceSeconds: int("HLS_TOKEN_GRACE_SECONDS", 21600),
  // Retransmissão (modo proxy): máximo de streams longos simultâneos neste processo (0 = sem limite).
  proxyMaxConcurrent: int("PROXY_MAX_CONCURRENT", 20),
  // Rota espelho Xtream (/player_api.php, /live, /movie, /series): validade da credencial entregue ao app.
  // Autorização da rota espelho em memória (modo proxy/redirect, credenciais, sessão e licença): 0 = consulta o banco a cada request.
  // Revogação/bloqueio valem em até este tempo (e na hora, neste processo, quando a sessão é revogada pelo próprio servidor).
  mirrorAuthCacheSeconds: int("MIRROR_AUTH_CACHE_SECONDS", 30),
  mirrorTokenTtlDays: int("MIRROR_TOKEN_TTL_DAYS", int("DEVICE_REFRESH_TTL_DAYS", 30)),
  // Catálogo persistente / importação de M3U.
  catalogMaxBytes: int("CATALOG_MAX_BYTES", 536870912),
  catalogConcurrency: int("CATALOG_CONCURRENCY", 2),
  catalogImportTimeoutMs: int("CATALOG_IMPORT_TIMEOUT_MS", 600000),
  catalogRefreshHours: int("CATALOG_REFRESH_HOURS", 12),
  playlistMaxBytes: int("PLAYLIST_MAX_MB", 0) * 1024 * 1024,
  // Catálogo Xtream sob demanda (cache em memória).
  xtreamCacheMaxBytes: int("XTREAM_CACHE_MAX_MB", 256) * 1024 * 1024,
  xtreamCacheTtlSeconds: int("XTREAM_CACHE_TTL_SECONDS", 600),
  xtreamCategoryTtlSeconds: int("XTREAM_CATEGORY_TTL_SECONDS", 3600),
  xtreamServerInfoTtlSeconds: int("XTREAM_SERVER_INFO_TTL_SECONDS", 3600),
  publicBaseUrl,
  pairingTokenTtl: int("PAIRING_TOKEN_TTL_SECONDS", 900),
  // URL do painel do revendedor (opcional): a página do QR mostra um atalho "Abrir painel" se estiver definida (http/https).
  panelUrl: /^https?:\/\/[^\s"'<>]+$/.test(e.PANEL_URL || "") ? e.PANEL_URL : "",
  // Lido a cada uso (getter) para permitir alternar em testes; em produção deve permanecer "false".
  get allowPrivateSources() {
    return !isProd && process.env.ALLOW_PRIVATE_SOURCES === "true";
  },
  // Sessões simultâneas por ativação (recuperação por MAC abre espaço removendo as mais antigas) e duração do acesso por chave.
  maxSessionsPerActivation: int("MAX_SESSIONS_PER_ACTIVATION", 3),
  deviceScopedSessionMinutes: int("DEVICE_SCOPED_SESSION_MINUTES", 30),
  // E-mail de saída (SMTP). Sem SMTP_HOST + MAIL_FROM o envio fica desligado e o painel avisa. A senha só existe aqui (.env).
  mail: mailConfig,
  enableScheduler: e.ENABLE_SCHEDULER !== "false",
  // Somente fora de produção (usado pela suíte de testes de integração).
  rateLimitDisabled: !isProd && e.RATE_LIMIT_DISABLED === "true",
});
