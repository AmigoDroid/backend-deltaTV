export const kindOf = (a) => (a.licenseId ? "license" : "partner");
export const configurationStatusOf = (activation, decision) => {
  if (activation.status === "revoked") return "deactivated";
  if (activation.status === "blocked") return "disabled";
  if (!decision.allowed)
    return /EXPIRED/.test(decision.code ?? "") ? "expired" : "disabled";
  if (activation.partnerId && !activation.providerId) return "error";
  // Mesmo critério de registration.service: provedor desativado = "error" (em /xtream seria 503).
  if (activation.partnerId && activation.PartnerProvider && activation.PartnerProvider.status !== "active" && !(process.env.PROVIDER_MONITOR_ENABLED==="true" && activation.partnerCodeId))
    return "error";
  if (activation.partnerId && activation.providerId)
    return "configured_partner";
  if (activation.licenseId && activation.playlistUrlEnc)
    return "configured_playlist";
  return "awaiting_configuration";
};
export const statusOf = (activation, decision) => {
  return {
    activationId: activation.id,
    configurationVersion: `${activation.updatedAt ? new Date(activation.updatedAt).toISOString() : ""}|${activation.PartnerProvider?.updatedAt ? new Date(activation.PartnerProvider.updatedAt).toISOString() : ""}`,
    mac: activation.mac,
    kind: kindOf(activation),
    allowed: decision.allowed,
    code: decision.code,
    message: decision.message,
    expiresAt: decision.expiresAt,
    configurationStatus: configurationStatusOf(activation, decision),
    listName: activation.playlistName ?? null,
    trial: activation.License?.isTrial ? { active: !!decision.allowed, expiresAt: activation.License.expiresAt } : null,
  };
};
