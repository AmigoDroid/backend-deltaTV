import { PartnerPreRegistration } from "../../db/models/index.js";
import { audit } from "../../shared/audit.js";

// A conclusão sai das pendências na mesma transação que salva as condições.
export async function markPartnerConfigured(partnerId, actor, transaction) {
  const [count] = await PartnerPreRegistration.update({ configuredAt: new Date() }, {
    where: { completedPartnerId: partnerId, status: "completed", configuredAt: null }, transaction,
  });
  if (count) await audit({ actor, action: "partner.onboarding_configured", entityType: "partner", entityId: partnerId, transaction });
  return count;
}
