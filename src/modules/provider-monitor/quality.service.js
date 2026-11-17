/** Qualidade coletiva baseada apenas em estados agregados, sem payload de mídia.
 * Os relatos dos aparelhos são indicativos; uma falha local NÃO reprova um
 * servidor sozinho. A seleção oficial continua no monitor + resolver.
 */
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { broadcastChange } from '../../realtime/socket.js';
import { classifyQuality } from './quality-policy.js';

const read = (sql,replacements) => sequelize.query(sql,{replacements,type:QueryTypes.SELECT});
const cache = new Map();
const CACHE_MS = 60_000;
const LIMIT = 120;
export function invalidateQualityCache() { cache.clear(); }
// A qualidade coletiva usa apenas o último estado vivo por TV, em memória.
// Não consulta mais device_connection_events nem device_connection_latest.
const STATS_SQL = `SELECT pp.id AS "providerId", pp.partner_id AS "partnerId", pp.name,
  h.state AS "healthState", h.latency_ms AS "probeLatencyMs"
  FROM partner_providers pp
  LEFT JOIN provider_health h ON h.provider_id=pp.id
  WHERE pp.deleted_at IS NULL AND (:partner IS NULL OR pp.partner_id=:partner)
  ORDER BY pp.name LIMIT :limit`;

export async function providerQuality(partnerId=null) {
  const key=partnerId||'*', hit=cache.get(key);
  if(hit && Date.now()-hit.time<CACHE_MS) return hit.data;
  const rows=await read(STATS_SQL,{partner:partnerId,limit:100});
  const data=rows.map(row => classifyQuality({ ...row,
    ...{ sampleDevices:0, affectedDevices:0, sampleEvents:0, errorEvents:0, bufferEvents:0 }
  }));
  if(cache.size>=LIMIT && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key,{time:Date.now(),data});
  return data;
}

export async function qualityForActivation(activationId,partnerId=null) {
  // Fonte estável, de configuração, não o servidor de reprodução que a TV possa ter escolhido.
  const [row]=await read(`SELECT pp.id AS "providerId",pp.name,h.state AS "healthState",
    h.latency_ms AS "probeLatencyMs"
    FROM activations a JOIN partner_providers pp ON pp.id=a.provider_id
    LEFT JOIN provider_health h ON h.provider_id=pp.id
    WHERE a.id=:aid AND (:partner IS NULL OR pp.partner_id=:partner) LIMIT 1`,
    {aid:activationId,partner:partnerId});
  return row ? {...row, selectionLive:false} : null;
}

let running = false;
export async function assessCollectiveQuality() {
  if(running) return;
  running=true;
  try {
    cache.clear();
    const samples=await providerQuality(null);
    // Relatar alertas por origem, nunca transitar ProviderHealth com base apenas no player.
    const bad=samples.filter(x=>x.severity!=='normal').slice(0,100);
    const activeIds=new Set(bad.map(x=>x.providerId));
    for(const s of bad){
      const id=randomUUID();
      const rows=await read(`INSERT INTO provider_quality_alerts
        (id,provider_id,partner_id,severity,affected_devices,sample_devices,first_seen_at,last_seen_at)
        VALUES (:id,:provider,:partner,:severity,:affected,:sample,now(),now())
        ON CONFLICT (provider_id) WHERE resolved_at IS NULL
        DO UPDATE SET severity=EXCLUDED.severity,affected_devices=EXCLUDED.affected_devices,
          sample_devices=EXCLUDED.sample_devices,last_seen_at=now()
        RETURNING (id=:id) AS inserted`,{id,provider:s.providerId,partner:s.partnerId,
          severity:s.severity,affected:s.affectedDevices,sample:s.sampleDevices});
      if(rows[0]?.inserted) broadcastChange({partnerId:s.partnerId,topic:'server-quality'});
    }
    // Resolver somente com evidência boa ou quando não houver relato há 20min.
    const open=await read(`SELECT q.id,q.provider_id AS "providerId",q.partner_id AS "partnerId",q.last_seen_at AS "lastSeenAt"
      FROM provider_quality_alerts q WHERE q.resolved_at IS NULL LIMIT 150`,{});
    for(const row of open){
      if(activeIds.has(row.providerId)) continue;
      const s=samples.find(x=>x.providerId===row.providerId);
      if((s && s.sampleDevices>=10 && s.severity==='normal') || Date.now()-new Date(row.lastSeenAt).getTime()>20*60000){
        await sequelize.query(`UPDATE provider_quality_alerts SET resolved_at=now()
          WHERE id=:id AND resolved_at IS NULL`,{replacements:{id:row.id}});
        broadcastChange({partnerId:row.partnerId,topic:'server-quality'});
      }
    }
  }finally{running=false;}
}
export async function recentQualityAlerts(partnerId=null){
  return read(`SELECT q.provider_id AS "providerId",pp.name,q.severity,
    q.affected_devices AS "affectedDevices",q.sample_devices AS "sampleDevices",
    q.first_seen_at AS "firstSeenAt",q.last_seen_at AS "lastSeenAt",q.resolved_at AS "resolvedAt"
    FROM provider_quality_alerts q JOIN partner_providers pp ON pp.id=q.provider_id
    WHERE pp.deleted_at IS NULL AND (:partner IS NULL OR q.partner_id=:partner) AND q.last_seen_at>now()-interval '7 days'
    ORDER BY q.last_seen_at DESC LIMIT 50`,{partner:partnerId});
}
