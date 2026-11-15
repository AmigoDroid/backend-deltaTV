/**
 * Classificação CONSERVADORA dos registros antigos. Nunca concede licença, prorroga prazo
 * nem unifica dois parceiros só porque o MAC é igual.
 */
export function assessLegacyRecord(row) {
  if (row.linkedSubscriptionId) return { state: 'linked', reason: 'Já possui vínculo comercial ativo.' };
  if (Number(row.activationCount) === 0) return { state: 'review', reason: 'Sem ativação não revogada nesta revenda.' };
  if (Number(row.activationCount) !== 1) return { state: 'review', reason: 'Mais de uma ativação candidata na mesma revenda.' };
  if (row.activationStatus !== 'active') return { state: 'review', reason: 'Ativação não está ativa.' };
  if (row.licenseStatus !== 'active' || !row.licenseExpiresAt || new Date(row.licenseExpiresAt).getTime() <= Date.now()) {
    return { state: 'review', reason: 'Licença ausente, vencida ou indisponível.' };
  }
  if (row.licenseOwnerPartnerId && String(row.licenseOwnerPartnerId) !== String(row.partnerId)) {
    return { state: 'review', reason: 'Propriedade da licença precisa ser conferida.' };
  }
  if (Number(row.otherPartnerCount) > 0) return { state: 'review', reason: 'MAC também possui vínculo em outra parceria; exige confirmação explícita.' };
  if (!row.commerceCustomerId) return { state: 'needs_customer', reason: 'Importar o cadastro antigo antes de associar um plano.' };
  return { state: 'ready', reason: 'Licença ativa; selecionar uma assinatura comercial válida para vincular.' };
}
