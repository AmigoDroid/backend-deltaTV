/** Business invariants. No TV licences or reseller-network data are touched here. */
export const PERMISSION_KEYS=Object.freeze(['canSell','canCreateSubmasters','canTransferStock','canViewFinance','canManageGateways']);
export const permissionColumns=Object.freeze({canSell:'can_sell',canCreateSubmasters:'can_create_submasters',canTransferStock:'can_transfer_stock',canViewFinance:'can_view_finance',canManageGateways:'can_manage_gateways'});
export function packageSnapshot(record){
  if(!record?.service_tier)return null; // pre-existing plans are legacy, never infer a paid service package
  return {
    code:record.code,name:record.name,revision:Number(record.revision||1),
    tier:record.service_tier,maxDns:record.max_dns==null?null:Number(record.max_dns),
    activationLimit:record.activation_limit==null?null:Number(record.activation_limit),
    autoFailover:Boolean(record.auto_failover),autoPriority:Boolean(record.auto_priority)&&Boolean(record.auto_failover),
    emailAlerts:Boolean(record.email_alerts),detailedHistory:Boolean(record.detailed_history)
  };
}
export function canGrantPermission(parent,permission){
  if(!Object.hasOwn(permissionColumns,permission))return false;
  return parent?.active===true && parent?.can_sell===true && parent[permissionColumns[permission]]===true;
}
export function permissionsFromRow(row){return Object.fromEntries(Object.entries(permissionColumns).map(([key,column])=>[key,Boolean(row?.[column])&&Boolean(row?.active)]));}
export function canMoveUnder({subjectId,destinationId,descendants=[]}){
  return subjectId!==destinationId&&!descendants.includes(destinationId);
}

/** Fluxos legados sem pacote técnico não são alterados retroativamente.
 * Toda VENDA NOVA exige comprovação externa ou confirmação manual autenticada. */
export function isPaidInviteReady({package_snapshot:servicePackage,payment_gateway:gateway,payment_status:status}={}){
 return !(servicePackage||gateway!=='manual')||status==='paid';
}
