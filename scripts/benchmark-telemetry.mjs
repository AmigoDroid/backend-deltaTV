#!/usr/bin/env node
/**
 * Teste realista do endpoint de telemetria. NÃO usar em produção sem controle.
 * Requer tokens de telemetria válidos de uma instalação de HOMOLOGAÇÃO.
 * JSONL, um por linha: {"token":"JWT válido","playback_id":"UUID v4"}
 * Execução: node scripts/benchmark-telemetry.mjs --url https://staging.example.com \
 *   --tokens /local/seguro/tokens.jsonl --duration 300 --interval 60 --concurrency 64
 * Nunca imprime tokens, identificadores de dispositivos ou payloads.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const get = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const url = get('url', '');
const filepath = get('tokens', '');
const duration = Math.min(3600, Math.max(30, Number(get('duration', '300')) || 300));
const interval = Math.min(300, Math.max(15, Number(get('interval', '60')) || 60));
const concurrency = Math.min(250, Math.max(1, Number(get('concurrency', '64')) || 64));
if (!url.startsWith('https://') || !filepath || !fs.existsSync(filepath)) {
  console.error('Uso: --url https://HOMOLOGACAO --tokens /arquivo/tokens.jsonl [--duration 300 --interval 60 --concurrency 64]');
  process.exit(2);
}
const clients = fs.readFileSync(filepath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line, idx) => {
  const row = JSON.parse(line);
  if (typeof row.token !== 'string' || !row.token.includes('.')) throw new Error(`token inválido na linha ${idx + 1}`);
  return { token: row.token, playback_id: row.playback_id || randomUUID(), next: Math.random() * interval * 1000 };
});
if (!clients.length) throw new Error('Nenhum cliente informado');
console.log(`Simulação: ${clients.length} TVs; intervalo médio ${interval}s; ${duration}s; concorrência até ${concurrency}`);
console.log('Atenção: destina-se a ambiente de homologação com sessões autorizadas.');
const endpoint = `${url.replace(/\/$/, '')}/api/v1/client/heartbeat/connection`;
const start = performance.now();
const until = start + duration * 1000;
const latencies = [];
const statuses = new Map();
let inflight = 0, total = 0, timeouts = 0, peak = 0;
const issue = async client => {
  inflight++;
  peak = Math.max(peak, inflight);
  const at = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${client.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'playing', playback_id: client.playback_id, position: 120, build: '46' }),
      signal: AbortSignal.timeout(5000),
    });
    const status = response.status;
    statuses.set(status, (statuses.get(status) || 0) + 1);
    await response.arrayBuffer();
  } catch { timeouts++; }
  finally { total++; latencies.push(performance.now() - at); inflight--; }
};
// Cada TV tem sua própria fase: não provoca rajadas artificiais a cada minuto.
let index = 0;
while (performance.now() < until) {
  if (inflight < concurrency) {
    const now = performance.now() - start;
    let found = false;
    for (let i = 0; i < clients.length; i++) {
      const item = clients[(index + i) % clients.length];
      if (item.next <= now) {
        item.next += interval * 1000;
        index = (index + i + 1) % clients.length;
        void issue(item);
        found = true;
        break;
      }
    }
    if (found) continue;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}
while (inflight) await new Promise(resolve => setTimeout(resolve, 30));
latencies.sort((a, b) => a - b);
const percentile = x => latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * x) - 1)]) : null;
console.log(JSON.stringify({ clients: clients.length, durationSeconds: duration, requests: total,
  requestsPerSecond: +(total / duration).toFixed(2), peakConcurrency: peak,
  latencyMs: { p50: percentile(.50), p95: percentile(.95), p99: percentile(.99) },
  timeouts, statuses: Object.fromEntries(statuses) }, null, 2));
