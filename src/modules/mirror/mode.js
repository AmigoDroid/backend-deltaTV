/**
 * Modo de entrega do conteúdo do provedor para a ativação:
 *  - "proxy":    o servidor assume a URL (rota espelho) e serve o conteúdo da origem; o app nunca vê a URL/credencial real.
 *  - "redirect": o servidor autoriza e responde 302 para a origem (não consome banda).
 * Lista própria do cliente (URL cifrada na ativação) é sempre proxy; parceria segue o modo do provedor.
 */
export const MIRROR_PASS = "mirror"; // o "usuário" é o token; a senha é só um valor fixo para players que exigem os dois campos

export function deliveryModeOf(activation) {
  if (activation?.playlistUrlEnc) return "proxy";
  return activation?.PartnerProvider?.deliveryMode === "proxy" ? "proxy" : "redirect";
}

/**
 * Modo efetivo de UMA ativação, para exibição no painel admin.
 *  - null  : ainda sem lista configurada (nada a entregar);
 *  - fixed : lista própria do cliente — sempre proxy, não depende de configuração.
 */
export function describeDelivery(activation) {
  if (activation?.playlistUrlEnc) return { deliveryMode: "proxy", deliveryModeFixed: true };
  if (!activation?.providerId) return { deliveryMode: null, deliveryModeFixed: false };
  return { deliveryMode: deliveryModeOf(activation), deliveryModeFixed: false };
}
