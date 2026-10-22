import { createHash } from "node:crypto";
import { PartnerProvider } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { decryptSecret } from "../../shared/crypto.js";
import { parseHttpUrl, safeGet } from "../../shared/ssrf.js";
import { env } from "../../config/env.js";
import { mirrorTokenFor } from "../access/access.service.js";
import { deliveryModeOf, MIRROR_PASS } from "../mirror/mode.js";

/**
 * Conexão Xtream Codes (player_api.php) do dispositivo.
 *
 * O servidor NÃO baixa, converte nem guarda lista M3U. Ele só:
 *  1. descobre qual painel/usuário/senha pertencem à ativação (parceria cadastrada ou URL da própria lista);
 *  2. confere no painel que a conta está ativa (chamada leve a player_api.php, sem listas);
 *  3. entrega esses dados ao app da TV, que consulta a API Xtream direto.
 */

export const XTREAM_UA = "Mozilla/5.0";
const MAX_BODY = 256 * 1024; // a resposta de autenticação tem poucos KB
const TRIES = 3;             // alguns painéis devolvem 404/5xx de forma intermitente
const PROBE_TTL_MS = 5 * 60_000;      // conta válida
const PROBE_BAD_TTL_MS = 60_000;      // recusa definitiva: curto, para a correção no provedor valer logo
const probeCache = new Map(); // chave (hash) -> { at, value }

/** Só a origem (http://host:porta), sem caminho nem credenciais. */
export function xtreamOrigin(raw) {
  const url = parseHttpUrl(raw);
  if (url.username || url.password) {
    throw new AppError(422, "INVALID_BASE_URL", "A URL base não deve conter usuário ou senha.");
  }
  return url.origin;
}

/**
 * Extrai painel + usuário + senha de uma URL de lista no padrão Xtream:
 *   http://host/get.php?username=U&password=P&type=m3u_plus
 *   http://host/playlist/U/P/m3u_plus
 *   http://host/live/U/P/123.ts   (e /movie/, /series/)
 * Devolve null se a URL não tiver cara de Xtream.
 */
export function xtreamFromUrl(raw) {
  let url;
  try { url = parseHttpUrl(raw); } catch { return null; }
  const qu = url.searchParams.get("username");
  const qp = url.searchParams.get("password");
  if (qu && qp) return { baseUrl: url.origin, username: qu, password: qp };
  const m = url.pathname.match(/^\/(?:playlist|live|movie|series)\/([^/]+)\/([^/]+)(?:\/|$)/i);
  if (m) return { baseUrl: url.origin, username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) };
  return null;
}

/** Credenciais Xtream da ativação: parceria (provedor + usuário/senha cifrados) ou URL própria da lista. */
export async function xtreamCredentialsOf(activation) {
  if (activation.playlistUrlEnc) {
    const parsed = xtreamFromUrl(decryptSecret(activation.playlistUrlEnc));
    if (!parsed) {
      throw new AppError(422, "NOT_XTREAM_LIST", "A lista cadastrada não é do tipo Xtream (usuário e senha no endereço).");
    }
    return parsed;
  }
  const provider = activation.providerId ? await PartnerProvider.findByPk(activation.providerId) : null;
  if (!provider || provider.status !== "active" || !activation.credentialsEnc) {
    throw new AppError(503, "PROVIDER_UNAVAILABLE", "Serviço indisponível. Contate seu fornecedor.");
  }
  let username, password;
  try {
    ({ username, password } = JSON.parse(decryptSecret(activation.credentialsEnc)));
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) throw new Error("credenciais incompletas");
  } catch (err) {
    // Chave de cifra trocada ou dado corrompido: erro explícito (e log) em vez de um 500 genérico.
    console.error(`[xtream] credentials_enc ilegível (activation ${activation.id}): ${err.message}`);
    throw new AppError(503, "CREDENTIALS_UNREADABLE", "Não foi possível ler as credenciais guardadas. Reconfigure a lista deste dispositivo.");
  }
  return { baseUrl: xtreamOrigin(provider.baseUrl), username, password };
}

export const hasXtreamSource = (activation) => !!(activation.providerId || activation.playlistUrlEnc);

async function readJson(res) {
  const chunks = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size > MAX_BODY) { res.destroy(); throw new Error("too-large"); }
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Pergunta ao painel se a conta existe e está ativa (player_api.php sem "action").
 * @returns {{ok:true, account:object}|{ok:false, reason:"invalid"|"unreachable"|"unverified", status?:string}}
 *   invalid    = o painel recusou a conta (auth=0, inativa/expirada)
 *   unreachable= sem resposta útil (rede, 5xx, HTML)
 *   unverified = 401/403 sem corpo do painel (bloqueio de IP/WAF): não prova que a senha está errada
 */
export async function probeAccount({ baseUrl, username, password }) {
  const key = createHash("sha256").update(`${baseUrl}\0${username}\0${password}`).digest("hex");
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < (hit.value.ok ? PROBE_TTL_MS : PROBE_BAD_TTL_MS)) return hit.value;

  const url = `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  let value = { ok: false, reason: "unreachable" };
  for (let i = 0; i < TRIES; i++) {
    let res;
    try {
      res = await safeGet(url, { headers: { "user-agent": XTREAM_UA, accept: "application/json" }, timeoutMs: 15000 });
    } catch {
      value = { ok: false, reason: "unreachable" };
      continue;
    }
    try {
      if ([401, 403].includes(res.statusCode)) {
        // Só é "senha recusada" se o PAINEL disser isso (JSON com auth=0/conta inativa). 401/403 sem esse corpo costuma ser
        // WAF/anti-bot bloqueando o IP do servidor: não dá para saber se a senha está certa ("unverified").
        let refusal = null;
        try { refusal = (await readJson(res))?.user_info ?? null; } catch { /* corpo não-JSON: bloqueio, não recusa */ }
        value = refusal && Number(refusal.auth) !== 1
          ? { ok: false, reason: "invalid" }
          : { ok: false, reason: "unverified", httpStatus: res.statusCode };
        break;
      }
      if (res.statusCode !== 200) { res.resume(); value = { ok: false, reason: "unreachable" }; continue; }
      const body = await readJson(res);
      const ui = body?.user_info;
      if (!ui || Number(ui.auth) !== 1) { value = { ok: false, reason: "invalid" }; break; }
      const status = String(ui.status ?? "Active");
      if (status.toLowerCase() !== "active") { value = { ok: false, reason: "invalid", status }; break; }
      value = {
        ok: true,
        account: {
          status,
          expiresAt: ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toISOString() : null,
          maxConnections: Number(ui.max_connections) || null,
          activeConnections: Number(ui.active_cons) || 0,
        },
      };
      break;
    } catch {
      value = { ok: false, reason: "unreachable" };
    } finally {
      res.destroy();
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  // Só guarda resposta definitiva; "unreachable"/"unverified" tentam de novo na próxima chamada.
  if (value.ok || value.reason === "invalid") probeCache.set(key, { at: Date.now(), value });
  return value;
}

export const forgetProbe = () => probeCache.clear();

/**
 * Corpo de GET /api/v1/client/xtream.
 *  - modo proxy:    baseUrl/usuário/senha são os da ROTA ESPELHO deste servidor (a credencial real nunca chega ao app);
 *  - modo redirect: credenciais reais do painel (o app conversa direto), mais `mirror` caso queira passar pelo servidor.
 * `sessionId` (sessão do app) é necessário para gerar a credencial do espelho.
 */
export async function xtreamConfigFor(activation, { sessionId } = {}) {
  const cred = await xtreamCredentialsOf(activation);
  const probe = await probeAccount(cred);
  if (!probe.ok && probe.reason === "invalid") {
    throw new AppError(403, "PROVIDER_ACCOUNT_INVALID", probe.status
      ? `A conta no provedor está ${probe.status}. Contate seu fornecedor.`
      : "Usuário ou senha recusados pelo provedor. Contate seu fornecedor.");
  }
  const mode = deliveryModeOf(activation);
  const account = probe.ok ? probe.account : null; // "unreachable": a TV pode alcançar o painel mesmo que o servidor não consiga
  const mirror = sessionId
    ? { baseUrl: env.publicBaseUrl, username: mirrorTokenFor(activation.id, sessionId), password: MIRROR_PASS }
    : null;

  if (mode === "proxy" && mirror) return { ...mirror, userAgent: XTREAM_UA, account, mode, mirror: true };
  return { ...cred, userAgent: XTREAM_UA, account, mode, mirror };
}
