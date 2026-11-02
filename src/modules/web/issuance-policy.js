/** Pure, side-effect-free commercial eligibility for a reseller's Web Player issuance.
 * All authorization is rechecked inside the activation transaction.
 */
export function webIssuePolicy({issuer, owner, code, terms}) {
  if (!issuer || !owner || !code || !["reseller","both"].includes(issuer.kind) || issuer.status!=="active")
    return {allowed:false, funding:null};
  if (issuer.id===owner.id) {
    return ["reseller","both"].includes(owner.kind) && Number.isInteger(code.licenseMonths) && code.licenseMonths>0
      ? {allowed:true,funding:"reseller_stock"}:{allowed:false,funding:null};
  }
  if (!["content","both"].includes(owner.kind) ||
      !terms?.allowWebIssuance || !code.allowWebIssuance ||
      !["credits","fixed_limited","fixed_unlimited"].includes(terms.mode) || code.licenseMonths)
    return {allowed:false,funding:null};
  return {allowed:true,funding:"content_partner_contract"};
}
