import { createHash, randomBytes } from 'node:crypto';

// Única fonte para novos cadastros: o catálogo original da rede.
export const planBenefits = plan => ({
  monthlyFeeCents: plan.monthlyPriceCents,
  dnsLimit: plan.maxServers,
  activationLimit: plan.activationLimit,
  validityDays: plan.validityDays,
  autoPriority: Boolean(plan.autoPriority),
});
export function planFingerprint(plan) {
  return createHash('sha256').update(JSON.stringify({
    key:plan.key,active:plan.active,...planBenefits(plan),
    autoFailover:plan.autoFailover,emailAlerts:plan.emailAlerts,detailedHistory:plan.detailedHistory,
  })).digest('hex');
}
export function expirationFromPlan(plan, now=new Date()) {
  const days=Number(plan.validityDays);
  if(!Number.isInteger(days)||days<1||days>3660)throw new Error('Prazo do plano inválido');
  return new Date(now.getTime()+days*86400_000);
}
export function networkSlug() {return `rede-${randomBytes(9).toString('hex')}`;}
