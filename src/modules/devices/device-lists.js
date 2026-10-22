/**
 * Um dispositivo (MAC) pode ter VÁRIAS ativações vivas — no máximo uma por parceiro, mais uma "sem parceiro"
 * (licença individual com lista própria). Funções puras: o serviço fornece as linhas, elas decidem.
 */

/**
 * Lista "principal" para os campos de nível superior do estado do dispositivo (compatível com clientes que
 * só conhecem UMA lista): prefere a que está liberada e configurada, depois a liberada, depois a configurada.
 * `lists` deve vir da mais recente para a mais antiga; empates ficam com a mais recente.
 */
export function pickPrimaryList(lists) {
  if (!lists?.length) return null;
  return lists.find((l) => l.allowed && l.configured)
    ?? lists.find((l) => l.allowed)
    ?? lists.find((l) => l.configured)
    ?? lists[0];
}

/**
 * Escolhe qual ativação viva uma operação deve afetar (ex.: "remover lista").
 *  - activationId informado  -> precisa ser uma das ativações vivas DESTE dispositivo;
 *  - não informado e há 1    -> essa;
 *  - não informado e há > 1  -> ambíguo: o chamador precisa dizer qual (nunca adivinhar);
 *  - não informado e há 0    -> sem ativação.
 * @returns {{activation: object|null, error?: "NOT_FOUND"|"ACTIVATION_REQUIRED"}}
 */
export function selectActivation(live, activationId) {
  if (activationId) {
    const found = live.find((a) => String(a.id) === String(activationId));
    return found ? { activation: found } : { activation: null, error: "NOT_FOUND" };
  }
  if (live.length > 1) return { activation: null, error: "ACTIVATION_REQUIRED" };
  return { activation: live[0] ?? null };
}
