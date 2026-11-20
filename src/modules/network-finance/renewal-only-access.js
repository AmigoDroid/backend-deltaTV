/** Expired network-linked partner receives ONLY read-only renewal access.
 * Never allow suspended, blocked, cancelled or non-network accounts. */
import { effectivePartnerStatus } from '../access/access.policy.js';
export function isNetworkRenewalOnlyPartner(partner) {
  return Boolean(partner?.ownerAdminId && partner?.status === 'active' && effectivePartnerStatus(partner) === 'expired');
}
export function isNetworkPortalAccessible(partner,audience) {
  if (!partner) return false;
  if (effectivePartnerStatus(partner) === 'active') return true;
  return audience === 'content_partner' && isNetworkRenewalOnlyPartner(partner);
}
