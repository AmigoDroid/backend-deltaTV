import { createHash } from "node:crypto";
import { PartnerProvider } from "../../db/models/index.js";
import { AppError } from "../../shared/errors.js";
import { decryptSecret } from "../../shared/crypto.js";
import { parseHttpUrl, safeGet } from "../../shared/ssrf.js";

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
const PROBE_TTL_MS = 5 * 60_000;
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
  const { username, password } = JSON.parse(decryptSecret(activation.credentialsEnc));
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
 * @returns {{ok:true, account:object}|{ok:false, reason:"invalid"|"unreachable", status?:string}}
 */
export async function probeAccount({ baseUrl, username, password }) {
  const key = createHash("sha256").update(`${baseUrl}\0${username}\0${password}`).digest("hex");
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;

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
      if ([401, 403].includes(res.statusCode)) { res.resume(); value = { ok: false, reason: "invalid" }; break; }
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
  // Só guarda resposta definitiva; "unreachable" tenta de novo na próxima chamada.
  if (value.ok || value.reason === "invalid") probeCache.set(key, { at: Date.now(), value });
  return value;
}

export const forgetProbe = () => probeCache.clear();

/** Corpo de GET /api/v1/client/xtream. */
export async function xtreamConfigFor(activation) {
  const cred = await xtreamCredentialsOf(activation);
  const probe = await probeAccount(cred);
  if (!probe.ok && probe.reason === "invalid") {
    throw new AppError(403, "PROVIDER_ACCOUNT_INVALID", probe.status
      ? `A conta no provedor está ${probe.status}. Contate seu fornecedor.`
      : "Usuário ou senha recusados pelo provedor. Contate seu fornecedor.");
  }
  // "unreachable": devolve mesmo assim; a TV pode alcançar o painel mesmo que o servidor não consiga.
  return { ...cred, userAgent: XTREAM_UA, account: probe.ok ? probe.account : null };
}
