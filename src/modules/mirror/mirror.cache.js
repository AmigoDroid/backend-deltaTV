/**
 * Cache em memória da autorização da rota espelho: evita ir ao banco (sessão + ativação + licença + parceria + provedor)
 * a cada request — um player HLS faz dezenas por minuto. Sem dependências: usado pelo serviço e por quem revoga sessões.
 *
 * Guarda o resultado completo (modo proxy/redirect, credenciais do provedor, decisão de acesso) por token, com TTL curto.
 * Negações também são guardadas, por pouco tempo (um app com sessão revogada não vira martelada no banco).
 * Requests simultâneos do mesmo token compartilham UMA consulta (single-flight).
 */
const MAX_ENTRIES = 5000;
const NEGATIVE_TTL_MS = 5000;

const entries = new Map(); // token -> { at, ttl, activationId, value?, error? }
const inflight = new Map(); // token -> Promise

export function dropMirrorAuth(activationId) {
  for (const [k, v] of entries) if (v.activationId === activationId) entries.delete(k);
}
export const clearMirrorAuth = () => { entries.clear(); inflight.clear(); };
export const mirrorAuthCacheSize = () => entries.size;

/**
 * @param {string} token
 * @param {()=>Promise<{activationId:string, value:any}>} load  consulta de verdade (banco); lança AppError se negado
 * @param {number} ttlMs  0 = não usa cache
 */
export async function cachedMirrorAuth(token, load, ttlMs) {
  if (!(ttlMs > 0)) return (await load()).value;

  const hit = entries.get(token);
  if (hit && Date.now() - hit.at < hit.ttl) {
    if (hit.error) throw hit.error;
    return hit.value;
  }
  entries.delete(token);

  let p = inflight.get(token);
  if (!p) {
    p = load()
      .then(({ activationId, value }) => {
        put(token, { activationId, value, ttl: ttlMs });
        return value;
      })
      .catch((error) => {
        // Só negações "de negócio" (AppError 4xx) ficam; falha de banco/rede não é cacheada.
        if (error?.status >= 400 && error.status < 500) put(token, { error, ttl: Math.min(ttlMs, NEGATIVE_TTL_MS) });
        throw error;
      })
      .finally(() => inflight.delete(token));
    inflight.set(token, p);
  }
  return p;
}

function put(token, e) {
  entries.set(token, { at: Date.now(), activationId: null, ...e });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value); // descarta o mais antigo
}
