/**
 * Quem pode editar um dispositivo pelo MAC no painel do revendedor.
 *
 * Decisão do produto (17/10/2026): QUALQUER revendedor cadastrado e ativo pode editar um dispositivo informando só o MAC;
 * a proteção é a AUDITORIA (quem — pessoa e revendedor — alterou qual TV, quando e o que mudou).
 * Isso difere do portal de parceiros (isolado por partnerId). Por isso a regra é uma política explícita e reversível:
 *
 *   DEVICE_EDIT_POLICY=any_reseller  (padrão) — qualquer revendedor ativo edita qualquer MAC.
 *   DEVICE_EDIT_POLICY=owner_only             — só edita MAC sem ativação viva ou cuja licença/parceria seja do próprio revendedor.
 *
 * Função pura: o serviço fornece os fatos; ela decide. Nunca recebe partnerId do cliente.
 */

export const EDIT_POLICIES = Object.freeze(["any_reseller", "owner_only"]);
export const RESELLER_KINDS = Object.freeze(["reseller", "both"]);

export const normalizePolicy = (value) => (EDIT_POLICIES.includes(value) ? value : "any_reseller");

/**
 * @param {object} p
 * @param {{id:string,kind:string}|null} p.partner               revendedor do usuário logado (vem do token)
 * @param {string} p.partnerEffectiveStatus                        resultado de effectivePartnerStatus()
 * @param {string} p.policy
 * @param {{ownerPartnerIds:string[], hasLiveActivation:boolean}} p.device  fatos do dispositivo
 */
export function evaluateResellerAccess({ partner, partnerEffectiveStatus, policy, device }) {
  if (!partner || !RESELLER_KINDS.includes(partner.kind)) {
    return { allowed: false, status: 403, code: "NOT_A_RESELLER", message: "Esta conta não é de um revendedor." };
  }
  if (partnerEffectiveStatus !== "active") {
    return { allowed: false, status: 403, code: "RESELLER_INACTIVE", message: "O cadastro do revendedor não está ativo." };
  }
  if (normalizePolicy(policy) === "owner_only" && device.hasLiveActivation && !device.ownerPartnerIds.includes(partner.id)) {
    return { allowed: false, status: 403, code: "DEVICE_OWNED_BY_OTHER", message: "Este dispositivo pertence a outro revendedor." };
  }
  return { allowed: true, status: 200, code: "OK", message: "" };
}
