import { AuditLog } from "../db/models/index.js";
import { maskDeep } from "./mask.js";

export const actorOf = (req) => ({
  type: req.user ? (req.user.role === "partner" ? "partner" : "admin") : "anonymous",
  id: req.user?.id ?? null,
  ip: req.ip,
  // Quem exatamente fez (pessoa e revendedor): vai para o metadata da auditoria, para responder "quem alterou esta TV?".
  name: req.user?.name ?? null,
  partnerId: req.user?.partnerId ?? null,
  partnerName: req.reseller?.partner?.name ?? null,
});

// Registra um evento. Dentro de transações, falhas propagam (auditoria faz parte da operação).
export async function audit({ actor, action, entityType, entityId, result = "success", metadata = {}, transaction }) {
  const row = {
    actorType: actor?.type ?? "system",
    actorId: actor?.id ? String(actor.id) : null,
    action,
    entityType: entityType ?? null,
    entityId: entityId ? String(entityId) : null,
    result,
    ip: actor?.ip ?? null,
    metadata: maskDeep({
      ...metadata,
      ...(actor?.name ? { actorName: actor.name } : {}),
      ...(actor?.partnerId ? { actorPartnerId: actor.partnerId } : {}),
      ...(actor?.partnerName ? { actorPartnerName: actor.partnerName } : {}),
    }),
  };
  if (transaction) return AuditLog.create(row, { transaction });
  try {
    return await AuditLog.create(row);
  } catch (e) {
    console.error("Falha ao gravar auditoria:", e.message);
  }
}
