/** Disponibilidade HTTP observada pelas sondagens, NÃO SLA real do vídeo. */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { percent } from './availability-math.js';
const query = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

export async function noteProbe(providerId, sample) {
  if (!providerId || !sample?.sampledAt) return;
  await sequelize.query(`INSERT INTO provider_health_hourly
      (provider_id,bucket,probes,ok_probes,slow_probes,latency_total_ms)
    VALUES (:id,date_trunc('hour', CAST(:checked AS timestamptz)),1,:ok,:slow,:latency)
    ON CONFLICT (provider_id,bucket) DO UPDATE SET
      probes=provider_health_hourly.probes+1,
      ok_probes=provider_health_hourly.ok_probes+EXCLUDED.ok_probes,
      slow_probes=provider_health_hourly.slow_probes+EXCLUDED.slow_probes,
      latency_total_ms=provider_health_hourly.latency_total_ms+EXCLUDED.latency_total_ms`, {
    replacements: { id: providerId, checked: sample.sampledAt,
      ok: sample.good ? 1 : 0, slow: sample.slow ? 1 : 0,
      latency: Math.max(0, Math.min(60000, Math.floor(Number(sample.latencyMs) || 0))) },
  });
}
const ranges = { '24h': 86400000, '7d': 7*86400000, '30d': 30*86400000 };
export async function availabilityForIds(ids) {
  if (!ids.length) return {};
  const rows = await query(`SELECT provider_id AS id, bucket, probes, ok_probes AS ok,
     slow_probes AS slow FROM provider_health_hourly
     WHERE provider_id IN (:ids) AND bucket >= :oldest`,
     { ids, oldest: new Date(Date.now() - ranges['30d'] - 3600000).toISOString() });
  const now = Date.now();
  const grouped = {};
  for (const id of ids) grouped[id] = { '24h': { all:0, ok:0, slow:0 }, '7d': { all:0, ok:0, slow:0 }, '30d': { all:0, ok:0, slow:0 } };
  for (const row of rows) {
    const date = new Date(row.bucket).getTime();
    if (!grouped[row.id]) continue;
    for (const [window, ms] of Object.entries(ranges)) if (date >= now - ms) {
      const target = grouped[row.id][window];
      target.all += Number(row.probes);
      target.ok += Number(row.ok);
      target.slow += Number(row.slow);
    }
  }
  return Object.fromEntries(ids.map(id => [id, Object.fromEntries(Object.entries(grouped[id]).map(([range, x]) =>
    [range, { percent: percent(x.ok, x.all), samples: x.all, slowSamples: x.slow }]))]));
}
export async function pruneAvailability() {
  // A única tabela nova armazena até 31 dias de totais horários, sem dados de espectadores.
  await sequelize.query(`DELETE FROM provider_health_hourly WHERE bucket < now() - interval '31 days'`);
}
