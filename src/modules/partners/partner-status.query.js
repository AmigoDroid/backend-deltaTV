/** Shared partner-list semantics, used by the DeltaTV list and by the scoped Admin list. */
import { Op } from "sequelize";
import { SIGNUP_PENDING_REASON } from "./reseller-signup.service.js";

export function partnerStatusWhere(status, now = new Date()) {
  if (status === "expired") return { status: "active", endsAt: { [Op.lte]: now } };
  if (status === "pending") return { status: "suspended", statusReason: SIGNUP_PENDING_REASON };
  if (status) return { status };
  return { status: { [Op.ne]: "deleted" } };
}
