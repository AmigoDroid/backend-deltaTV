/** Permissão exclusiva do Master principal. Nunca herdada por Submasters. */
export const isPrimaryMaster = (p) => !!p && p.distributionRole === "master" &&
  p.parentPartnerId == null && (p.kind === "reseller" || p.kind === "both");

export function maySelfIssue(partner, explicitAuthorization) {
  return isPrimaryMaster(partner) && explicitAuthorization === true &&
    partner.status === "active" && (!partner.endsAt || new Date(partner.endsAt) > new Date());
}
