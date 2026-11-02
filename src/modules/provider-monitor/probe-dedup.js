/**
 * A medição do monitor consulta exclusivamente /player_api.php (sem credenciais).
 * A chave representa a requisição HTTP efetiva, NÃO o ID do parceiro/provedor.
 * URL normaliza esquema, host e porta padrão, mas nunca confunde HTTP com HTTPS
 * ou portas distintas. A proteção SSRF continua sendo feita pelo probe real.
 */
import { xtreamApiUrl } from "./url-utils.js";

export function probeTargetKey(raw) {
  try {
    const base = new URL(String(raw).trim());
    if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("unsupported protocol");
    return xtreamApiUrl(base).href;
  } catch {
    // Endereços inválidos nunca devem colidir com URLs válidas.
    return `invalid:${String(raw).trim()}`;
  }
}

/**
 * Coalescência de sondagens em andamento + cache LRU pequeno de resultados.
 * Uma mesma URL é consultada uma vez durante a janela de monitoramento, mesmo
 * quando pertence a várias parcerias. Nunca guarda conteúdo ou credenciais.
 *
 * @param {(raw:string)=>Promise<object>} probe função real de sondagem
 * @param {{ttlMs?:number, maxEntries?:number, now?:()=>number}} options
 */
export function createSharedProbe(probe, { ttlMs = 60_000, maxEntries = 1000, now = Date.now } = {}) {
  if (typeof probe !== "function") throw new TypeError("probe must be a function");
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new RangeError("ttlMs must be nonnegative");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be positive");
  const cache = new Map();
  const inFlight = new Map();
  const stats = { requests: 0, reused: 0, joined: 0, evictions: 0 };

  async function shared(raw) {
    const key = probeTargetKey(raw);
    const t = now();
    const hit = cache.get(key);
    if (hit && t < hit.expiresAt) {
      cache.delete(key);
      cache.set(key, hit); // LRU: mantem em memoria os destinos mais usados
      stats.reused++;
      return hit.value;
    }
    if (hit) cache.delete(key);
    const active = inFlight.get(key);
    if (active) { stats.joined++; return active; }

    // Envia a URL ORIGINAL para validar DNS, destino público e proteções SSRF.
    // A mesma medição mantém o instante real do teste em todos os provedores.
    const task = Promise.resolve().then(() => {
      stats.requests++;
      return probe(raw);
    }).then(value => {
      const measured = { ...value, sampledAt: new Date(now()) };
      if (ttlMs > 0) {
        cache.delete(key);
        cache.set(key, { value: measured, expiresAt: now() + ttlMs });
        if (cache.size > maxEntries) {
          cache.delete(cache.keys().next().value);
          stats.evictions++;
        }
      }
      return measured;
    }).finally(() => { inFlight.delete(key); });
    inFlight.set(key, task);
    return task;
  }

  shared.stats = () => ({ ...stats, cached: cache.size, inFlight: inFlight.size });
  return shared;
}

/** Evita tratar a mesma medição reutilizada como duas falhas/sucessos seguidos. */
export function isNewProbeSample(lastCheckedAt, sampledAt) {
  if (!lastCheckedAt || !sampledAt) return true;
  const previous = new Date(lastCheckedAt).getTime();
  const measured = new Date(sampledAt).getTime();
  return !Number.isFinite(previous) || !Number.isFinite(measured) || measured > previous;
}
