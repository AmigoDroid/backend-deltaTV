/**
 * Modo de entrega do Player Web POR TIPO de conteúdo.
 *
 *  - api:    catálogo (player_api.php, get.php, xmltv.php). redirect por padrão; se o navegador for barrado por CORS no provedor, troque para proxy.
 *  - live:   TV ao vivo. Só funciona via proxy (http misto/CORS/HLS reescrito pelo servidor).
 *  - movie:  filmes. redirect (302 para a origem: não gasta banda do servidor).
 *  - series: episódios. redirect.
 *
 * Esses são os PADRÕES de um acesso web novo. Depois de criado, o admin ou o dono (revendedor) pode trocar cada tipo.
 * Módulo puro (sem banco/env). Os padrões podem ser trocados por WEB_DELIVERY_DEFAULTS="api=proxy,live=proxy,movie=redirect,series=redirect".
 */
export const MODE_KINDS = Object.freeze(["api", "live", "movie", "series"]);
export const MODE_VALUES = Object.freeze(["proxy", "redirect"]);
export const WEB_DEFAULT_MODES = Object.freeze({ api: "redirect", live: "proxy", movie: "redirect", series: "redirect" });

/** Aceita só chaves e valores conhecidos; ignora o resto. Devolve {} se nada servir. */
export function sanitizeModes(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const k of MODE_KINDS) if (MODE_VALUES.includes(input[k])) out[k] = input[k];
  return out;
}

/** "api=proxy,live=proxy,movie=redirect" -> { api, live, movie }. Valor inválido é ignorado. */
export function parseModesEnv(text) {
  const out = {};
  for (const part of String(text ?? "").split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim().toLowerCase());
    if (MODE_KINDS.includes(k) && MODE_VALUES.includes(v)) out[k] = v;
  }
  return out;
}

/** Padrões de um acesso web novo: WEB_DEFAULT_MODES sobrescrito pelo ambiente. */
export const webDefaultModes = (envText = "") => ({ ...WEB_DEFAULT_MODES, ...parseModesEnv(envText) });

/**
 * Modo efetivo por tipo.
 *  1. override por tipo gravado na ativação (deliveryModes);
 *  2. modo único definido pelo superadmin (legado, vale para tudo);
 *  3. `fallback` (modo automático de sempre: lista própria = redirect; parceria = modo do provedor).
 */
export function resolveModes({ deliveryModes, forced = null, fallback }) {
  const per = sanitizeModes(deliveryModes);
  const out = {};
  for (const k of MODE_KINDS) out[k] = per[k] ?? (MODE_VALUES.includes(forced) ? forced : fallback);
  return out;
}

/** O servidor precisa ficar no meio (espelho) se QUALQUER tipo for proxy: as URLs de mídia saem do espelho. */
export const needsMirror = (modes) => MODE_KINDS.some((k) => modes[k] === "proxy");
