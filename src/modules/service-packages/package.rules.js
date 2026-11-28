import crypto from 'node:crypto';

/** A single service package is the source of truth for new sales.  Physical
 * legacy tables remain for existing accounts and regulatory/audit history. */
export function technicalTierForPackage(code) {
  const prefix = `pkg_${String(code).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  const suffix = crypto.createHash('sha256').update(String(code)).digest('hex').slice(0,6);
  return `${prefix.slice(0,25)}_${suffix}`;
}
export function assertPackageInput(p) {
  if (!p || !/^[a-z][a-z0-9_-]{1,31}$/.test(p.code||'')) throw new RangeError('Identificador de pacote inválido');
  if (p.autoPriority && !p.autoFailover) throw new RangeError('Prioridade requer failover');
  if (!Number.isSafeInteger(p.wholesaleCents)||p.wholesaleCents<0 || !Number.isSafeInteger(p.minResaleCents) || p.minResaleCents<0)
    throw new RangeError('Preço inválido');
  if(p.minResaleCents<p.wholesaleCents)throw new RangeError('Revenda abaixo do custo negociado');
  if(p.maxDns!==null && (!Number.isInteger(p.maxDns)||p.maxDns<1))throw new RangeError('Limite de DNS inválido');
  if(p.activationLimit!==null && (!Number.isInteger(p.activationLimit)||p.activationLimit<0))throw new RangeError('Limite de ativações inválido');
  if(p.maxApps!==undefined && (!Number.isInteger(p.maxApps)||p.maxApps<0||p.maxApps>50))throw new RangeError('Limite de apps próprios inválido');
  return p;
}
export function packageSnapshotFromRow(p){
 if(!p?.service_tier)return null;
 return {code:p.code,name:p.name,revision:Number(p.revision||1),tier:p.service_tier,
  maxDns:p.max_dns===null?null:Number(p.max_dns),activationLimit:p.activation_limit===null?null:Number(p.activation_limit),maxApps:Number(p.max_apps??0),
  autoFailover:!!p.auto_failover,autoPriority:!!p.auto_priority&&!!p.auto_failover,
  emailAlerts:!!p.email_alerts,detailedHistory:!!p.detailed_history};
}
