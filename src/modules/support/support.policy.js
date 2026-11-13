/** Reconciliação apenas de LEITURA. Não escolhe um aparelho arbitrário pelo MAC. */
export function selectClientActivations(client, activations) {
  const mac = String(client?.mac || '').trim().toUpperCase();
  const partnerId = String(client?.partnerId || '');
  const eligible = (activations || []).filter(a =>
    String(a.partnerId || '') === partnerId && String(a.mac || '').trim().toUpperCase() === mac);
  const ids = new Set(eligible.map(a => String(a.deviceId || '')));
  if (!mac || !partnerId || ids.has('')) return { matches: [], ambiguous: true };
  if (client?.deviceId) {
    const matches = eligible.filter(a => String(a.deviceId) === String(client.deviceId));
    return { matches, ambiguous: eligible.length > matches.length };
  }
  if (ids.size > 1) return { matches: [], ambiguous: true };
  return { matches: eligible, ambiguous: false };
}
