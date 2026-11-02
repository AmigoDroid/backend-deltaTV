// Política de proxy confiável da API Delta TV.
// Confia no Nginx em loopback, nunca em cabeçalhos fornecidos diretamente pela Internet.
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function resolveBindHost(nodeEnv, configuredHost) {
  const value = String(configuredHost ?? "").trim();
  return value || (nodeEnv === "production" ? "127.0.0.1" : "0.0.0.0");
}

export function resolveTrustProxy(configuredValue, { isProd, bindHost } = {}) {
  const raw = String(configuredValue ?? "").trim().toLowerCase();
  // Padrão seguro da implantação VPS: somente Nginx local é confiável.
  // Se a API estiver ligada em 0.0.0.0 ou em outra interface, não confie implicitamente em proxies.
  if (!raw) return isProd && loopbackHosts.has(bindHost) ? "loopback" : 0;
  if (raw === "loopback") return "loopback";
  if (raw === "false") return 0;
  if (raw === "true") return true; // compatibilidade, não recomendado em produção
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  throw new Error('TRUST_PROXY inválido: use "loopback", "0" ou, apenas com configuração auditada, outro valor aceito.');
}

export function proxyConfigurationWarnings({ isProd, bindHost, trustProxy }) {
  if (!isProd) return [];
  const warnings = [];
  if (loopbackHosts.has(bindHost) && trustProxy === 0) {
    warnings.push("TRUST_PROXY=0: atrás do Nginx, req.ip será 127.0.0.1. Configure TRUST_PROXY=loopback no .env.");
  }
  if (trustProxy === true || (typeof trustProxy === "number" && trustProxy > 0)) {
    warnings.push("TRUST_PROXY irrestrito/por saltos: prefira loopback para evitar IPs falsificados em X-Forwarded-For.");
  }
  return warnings;
}
