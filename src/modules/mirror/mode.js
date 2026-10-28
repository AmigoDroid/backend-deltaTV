/**
 * Modo de entrega do conteúdo do provedor para a ativação:
 *  - "proxy":    o servidor assume a URL (rota espelho) e serve o conteúdo da origem; o app nunca vê a URL/credencial real.
 *  - "redirect": o servidor autoriza e responde 302 para a origem (não consome banda).
 * Ordem de decisão:
 *  1. modo definido pelo superadmin nesta ativação (activations.delivery_mode);
 *  2. lista própria do cliente (URL cifrada na ativação): redirect — o app fala direto com o painel do provedor;
 *  3. parceria: o modo do provedor.
 */
export const MIRROR_PASS = "mirror"; // o "usuário" é o token; a senha é só um valor fixo para players que exigem os dois campos
export const DELIVERY_MODES = Object.freeze(["proxy", "redirect"]);

const overrideOf = (activation) => (DELIVERY_MODES.includes(activation?.deliveryMode) ? activation.deliveryMode : null);

export function deliveryModeOf(activation) {
  const forced = overrideOf(activation);
  if (forced) return forced;
  if (activation?.playlistUrlEnc) return "redirect";
  return activation?.PartnerProvider?.deliveryMode === "proxy" ? "proxy" : "redirect";
}

/**
 * Modo efetivo de UMA ativação, para exibição no painel admin.
 *  - null  : ainda sem lista configurada (nada a entregar);
 *  - override: definido manualmente pelo superadmin;
 *  - fixed : lista própria do cliente — redirect automático, não depende de configuração.
 */
export function describeDelivery(activation) {
  const forced = overrideOf(activation);
  if (forced) return { deliveryMode: forced, deliveryModeFixed: false, deliveryModeOverride: true };
  if (activation?.playlistUrlEnc) return { deliveryMode: "redirect", deliveryModeFixed: true, deliveryModeOverride: false };
  if (!activation?.providerId) return { deliveryMode: null, deliveryModeFixed: false, deliveryModeOverride: false };
  return { deliveryMode: deliveryModeOf(activation), deliveryModeFixed: false, deliveryModeOverride: false };
}
