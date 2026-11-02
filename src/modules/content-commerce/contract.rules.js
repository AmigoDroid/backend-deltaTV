/** Regras puras, compartilhadas com testes unitários. */
export function shouldCharge({isNew,previousCodeId,codeId,alreadyCharged=false}) {
  return !alreadyCharged && (isNew || previousCodeId !== codeId);
}
export function remainingLicenses({mode,activationLimit,activeDevices,availableCredits,creditsPerActivation}) {
  if(mode==="fixed_unlimited")return null;
  if(mode==="fixed_limited")return Math.max(0,activationLimit-activeDevices);
  if(mode==="credits")return Math.floor(availableCredits/creditsPerActivation);
  return null;
}
export function rankHealthy(a,b,automatic=true) {
  const rank=s=>s.state==="healthy"?0:s.state==="down"?2:1;
  const rankDiff=rank(a)-rank(b);
  if(rankDiff)return rankDiff;
  const latency=(a.latencyMs??Infinity)-(b.latencyMs??Infinity);
  const manual=a.priority-b.priority;
  return automatic?(latency||manual):(manual||latency);
}
