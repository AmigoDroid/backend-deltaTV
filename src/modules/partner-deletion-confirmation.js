/**
 * Verificação humana da exclusão administrativa. A operação continua vinculada ao
 * UUID da parceria na rota, e só o superadmin pode executá-la. Mantém suporte ao
 * identificador usado por versões anteriores do painel.
 */
export const normalizePartnerDeletionConfirmation = (value) =>
  String(value ?? "").normalize("NFKC").trim().toLocaleLowerCase("pt-BR");

export const matchesPartnerDeletionConfirmation = (confirmation, partner) => {
  const typed = normalizePartnerDeletionConfirmation(confirmation);
  if (!typed) return false;
  return [partner?.name, partner?.slug]
    .some((value) => typed === normalizePartnerDeletionConfirmation(value));
};
