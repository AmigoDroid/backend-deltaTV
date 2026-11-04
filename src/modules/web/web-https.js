// Política exclusiva dos dispositivos do PlayerWeb. Não altera URLs persistidas do parceiro.
export const isWebActivation = activation => activation?.Device?.platform === "web" || /^webtv-/i.test(activation?.installationId || "");
export const usesWebHttps = activation => isWebActivation(activation) && !activation?.playlistUrlEnc && activation?.webAutoHttps !== false;

/** Troca somente o protocolo; mantém caminho, query e portas personalizadas. */
export function withHttps(raw, enabled = true) {
  if (!enabled) return raw;
  const url = new URL(raw);
  if (url.protocol !== "http:") return raw;
  url.protocol = "https:";
  return url.href;
}
export const webBaseUrl = (raw, activation) => withHttps(raw, usesWebHttps(activation));
export function webProvider(provider, activation) {
  if (!provider || !usesWebHttps(activation)) return provider;
  const data = provider.toJSON ? provider.toJSON() : provider;
  return { ...data, baseUrl: webBaseUrl(data.baseUrl, activation) };
}

// Alguns painéis devolvem segmentos absolutos em HTTP mesmo quando a playlist veio por HTTPS.
// Só ajusta links do mesmo host do parceiro; CDNs de outros hosts continuam sob o proxy existente.
export function webHlsTarget(raw, credentials) {
  if (!credentials?.webAutoHttps) return raw;
  const target = new URL(raw);
  if (target.hostname !== new URL(credentials.baseUrl).hostname) return raw;
  return withHttps(raw);
}
