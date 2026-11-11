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
/** Cada amostra usa o servidor selecionado MAIS RECENTEMENTE, não comprova
 * a origem final depois de redirects, portanto exibimos atribuição estimada. */
const STATS_SQL = `SELECT pp.id AS "providerId", pp.partner_id AS "partnerId",pp.name,
  h.state AS "healthState",h.latency_ms AS "probeLatencyMs",
  count(DISTINCT sel.activation_id)::integer AS "sampleDevices",
  count(DISTINCT CASE WHEN ev.state IN ('buffering','error') THEN ev.activation_id END)::integer AS "affectedDevices",
  count(ev.id)::integer AS "sampleEvents",
  count(ev.id) FILTER (WHERE ev.state='error')::integer AS "errorEvents",
  count(ev.id) FILTER (WHERE ev.state='buffering')::integer AS "bufferEvents"
FROM partner_providers pp
LEFT JOIN provider_health h ON h.provider_id=pp.id
LEFT JOIN device_connection_latest sel ON sel.provider_id=pp.id AND sel.source='selection'
  AND sel.created_at>now()-interval '20 minutes'
LEFT JOIN device_connection_events ev ON ev.activation_id=sel.activation_id AND ev.source='tv'
  AND ev.created_at>now()-interval '10 minutes'
WHERE (:partner IS NULL OR pp.partner_id=:partner)
GROUP BY pp.id,pp.partner_id,pp.name,h.state,h.latency_ms
ORDER BY "affectedDevices" DESC, "sampleDevices" DESC
LIMIT :limit`;


export async function providerQuality(partnerId=null) {
  const key=partnerId||'*', hit=cache.get(key);
  if(hit && Date.now()-hit.time<CACHE_MS) return hit.data;
  const rows=await read(STATS_SQL,{partner:partnerId,limit:100});
  const data=rows.map(classifyQuality);
  if(cache.size>=LIMIT && !cache.has(key)) cache.delete(cache.keys().next().value);
  cache.set(key,{time:Date.now(),data});
  return data;
}

export async function qualityForActivation(activationId,partnerId=null) {
  const [row]=await read(`SELECT pp.id AS "providerId",pp.name,h.state AS "healthState",
    h.latency_ms AS "probeLatencyMs",s.created_at AS "selectedAt",
    q.severity,q.affected_devices AS "affectedDevices",q.sample_devices AS "sampleDevices",
    q.last_seen_at AS "alertAt"
    FROM device_connection_latest s JOIN partner_providers pp ON pp.id=s.provider_id
    LEFT JOIN provider_health h ON h.provider_id=pp.id
    LEFT JOIN provider_quality_alerts q ON q.provider_id=pp.id AND q.resolved_at IS NULL
    WHERE s.activation_id=:aid AND s.source='selection'
      AND (:partner IS NULL OR pp.partner_id=:partner) LIMIT 1`,{aid:activationId,partner:partnerId});
  return row || null;
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
    WHERE (:partner IS NULL OR q.partner_id=:partner) AND q.last_seen_at>now()-interval '7 days'
    ORDER BY q.last_seen_at DESC LIMIT 50`,{partner:partnerId});
}
