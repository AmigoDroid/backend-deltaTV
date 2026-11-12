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
const ranges = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

/**
 * Um unico GROUP BY no PostgreSQL em vez de transferir centenas de linhas
 * horarias por servidor ao Node. A resposta permanece identica ao contrato
 * anterior: percent, samples e slowSamples para cada janela.
 *
 * O indice (provider_id, bucket) ja existe como chave primaria desde a B63;
 * nao criamos uma copia dele.
 */
export async function availabilityForIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return {};
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return {};

  const now = Date.now();
  const replacements = {
    ids: uniqueIds,
    since24h: new Date(now - ranges['24h']).toISOString(),
    since7d: new Date(now - ranges['7d']).toISOString(),
    since30d: new Date(now - ranges['30d']).toISOString(),
  };
  const rows = await query(`SELECT provider_id AS id,
      COALESCE(SUM(probes) FILTER (WHERE bucket >= CAST(:since24h AS timestamptz)),0) AS probes_24h,
      COALESCE(SUM(ok_probes) FILTER (WHERE bucket >= CAST(:since24h AS timestamptz)),0) AS ok_24h,
      COALESCE(SUM(slow_probes) FILTER (WHERE bucket >= CAST(:since24h AS timestamptz)),0) AS slow_24h,
      COALESCE(SUM(probes) FILTER (WHERE bucket >= CAST(:since7d AS timestamptz)),0) AS probes_7d,
      COALESCE(SUM(ok_probes) FILTER (WHERE bucket >= CAST(:since7d AS timestamptz)),0) AS ok_7d,
      COALESCE(SUM(slow_probes) FILTER (WHERE bucket >= CAST(:since7d AS timestamptz)),0) AS slow_7d,
      COALESCE(SUM(probes) FILTER (WHERE bucket >= CAST(:since30d AS timestamptz)),0) AS probes_30d,
      COALESCE(SUM(ok_probes) FILTER (WHERE bucket >= CAST(:since30d AS timestamptz)),0) AS ok_30d,
      COALESCE(SUM(slow_probes) FILTER (WHERE bucket >= CAST(:since30d AS timestamptz)),0) AS slow_30d
    FROM provider_health_hourly
    WHERE provider_id IN (:ids) AND bucket >= CAST(:since30d AS timestamptz)
    GROUP BY provider_id`, replacements);

  const byId = new Map(rows.map(r => [String(r.id), r]));
  const summary = (row, range) => {
    const samples = Number(row?.[`probes_${range}`] ?? 0);
    const ok = Number(row?.[`ok_${range}`] ?? 0);
    return { percent: percent(ok, samples), samples, slowSamples: Number(row?.[`slow_${range}`] ?? 0) };
  };
  return Object.fromEntries(ids.map(id => {
    const row = byId.get(String(id));
    return [id, { '24h': summary(row,'24h'), '7d': summary(row,'7d'), '30d': summary(row,'30d') }];
  }));
}

export async function pruneAvailability() {
  // A única tabela nova armazena até 31 dias de totais horários, sem dados de espectadores.
  await sequelize.query(`DELETE FROM provider_health_hourly WHERE bucket < now() - interval '31 days'`);
}
