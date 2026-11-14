/** Política do cadastro público: somente convites VÁLIDOS do Master têm ativação imediata. */
export const INVITED_RESELLER_RESTRICTED_RESOURCES = Object.freeze([
  "servers", "white_label", "remote", "web", "codes",
]);

export const invitedSignupState = (hasValidatedNetworkInvite) => ({
  status: hasValidatedNetworkInvite ? "active" : "suspended",
  statusReason: hasValidatedNetworkInvite ? null : "Aguardando aprovação do cadastro",
});

/** Link público preserva o token no fragmento: não é enviado ao servidor HTTP da página. */
export const buildResellerInviteUrl = (portalUrl, token) => {
  const url = new URL(portalUrl || "https://revenda.deltatv.com.br");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Origem de convite inválida");
  if (!/^[A-Za-z0-9_-]{32,120}$/.test(String(token))) throw new Error("Token de convite inválido");
  return `${url.origin}/#cadastro?convite=${encodeURIComponent(token)}`;
};
