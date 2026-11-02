/** Estabilidade de roteamento: apenas trocar por vantagem relevante ou falha do servidor atual. */
export function selectHealthy(ranked, pinned, now, minImprovementMs = 50, minImprovementRatio = 0.15) {
  if (!ranked.length) return null;
  const current=ranked.find(s=>s.id===pinned?.providerId);
  if(!current)return ranked[0];
  if(pinned.until>now)return current;
  const fastest=ranked[0];
  if(fastest.id===current.id)return current;
  const oldMs=Math.max(0,Number(current.latencyMs)||0);
  const newMs=Math.max(0,Number(fastest.latencyMs)||0);
  if(oldMs-newMs<minImprovementMs || (oldMs>0 && (oldMs-newMs)/oldMs<minImprovementRatio))return current;
  return fastest;
}
