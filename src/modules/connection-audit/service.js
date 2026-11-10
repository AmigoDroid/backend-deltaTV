import { touchDevice } from '../devices/presence.js';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { notFound } from '../../shared/errors.js';

// Nenhuma URL completa, credencial Xtream, query string ou token entra no banco.
export function safeOrigin(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && u.origin.length <= 512 ? u.origin : null;
  } catch { return null; }
}
export const ipFamily = value => isIP(String(value || '').replace(/^::ffff:/i, '')) || null;
const query = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

export async function ownership(id) {
  return (await query(`SELECT a.id, a.device_id, a.partner_id,
    COALESCE(g.owner_partner_id,l.owner_partner_id) reseller_id
    FROM activations a LEFT JOIN licenses g ON g.id=a.granted_license_id
    LEFT JOIN licenses l ON l.id=a.license_id WHERE a.id=:id`, { id }))[0];
}
export function canRead(owner, partnerId) {
  return !!owner && (!partnerId || owner.partner_id === partnerId || owner.reseller_id === partnerId);
}

const COLUMNS = 'id,activation_id,session_id,partner_id,reseller_id,source,state,origin,selected_origin,provider_id,transport,status_code,error_code,position,build,playback_id,client_family,upstream_family,latency_ms,created_at';
const UPDATE_COLUMNS = COLUMNS.split(',').filter(c => !['activation_id', 'source'].includes(c));
const CHANGE_COLUMNS = ['session_id','partner_id','reseller_id','state','origin','selected_origin','provider_id','transport','status_code','error_code','playback_id'];
const CHANGED = CHANGE_COLUMNS.map(c => `device_connection_latest.${c} IS DISTINCT FROM EXCLUDED.${c}`).join(' OR ');
const UPDATES = UPDATE_COLUMNS.map(c => `${c}=EXCLUDED.${c}`).join(',');

// Uma consulta para dezenas/centenas de TVs: ownership em JOIN, UPSERT do estado e
// amostra de histórico de 5 min, sem SELECT extra por evento. Um registro por
// (ativação, origem) em cada lote, evitando o erro PostgreSQL 21000.
const BULK_SQL = `WITH input AS (
  SELECT j.*, a.device_id, a.partner_id AS owner_partner,
         COALESCE(g.owner_partner_id,l.owner_partner_id) AS owner_reseller
  FROM jsonb_to_recordset(CAST(:batch AS jsonb)) AS j(
    id uuid, activation uuid, session uuid, source text, state text,
    origin text, selected text, provider uuid, transport text,
    status integer, error text, position integer, build text, playback uuid,
    family integer, upfamily integer, latency integer, received timestamptz)
  JOIN activations a ON a.id=j.activation
  LEFT JOIN licenses g ON g.id=a.granted_license_id
  LEFT JOIN licenses l ON l.id=a.license_id
), updated AS (
  INSERT INTO device_connection_latest (${COLUMNS},last_event_at)
  SELECT id,activation,session,owner_partner,owner_reseller,source,state,origin,selected,
    provider,transport,status,error,position,build,playback,family,upfamily,latency,received,received
  FROM input
  ON CONFLICT (activation_id,source) DO UPDATE SET ${UPDATES},
    last_event_at=CASE WHEN (${CHANGED})
      OR device_connection_latest.last_event_at < NOW()-INTERVAL '5 minutes'
      THEN EXCLUDED.created_at ELSE device_connection_latest.last_event_at END
  WHERE device_connection_latest.created_at <= EXCLUDED.created_at
  RETURNING *
), history AS (
  INSERT INTO device_connection_events (${COLUMNS})
  SELECT ${COLUMNS} FROM updated WHERE last_event_at=created_at RETURNING id
)
SELECT DISTINCT device_id FROM input WHERE source='tv' AND device_id IS NOT NULL
  AND (SELECT count(*) FROM history) >= 0`;

function normalize(event) {
  const latency = Number.isFinite(event.latencyMs)
    ? Math.min(2147483647, Math.max(0, Math.floor(event.latencyMs))) : null;
  return {
    id: randomUUID(), activation: event.activationId, session: event.sessionId || null,
    source: event.source, state: event.state, origin: safeOrigin(event.origin),
    selected: safeOrigin(event.selectedOrigin), provider: event.providerId || null,
    transport: event.transport || null, status: event.statusCode || null,
    error: event.errorCode ? String(event.errorCode).replace(/[^A-Za-z0-9_-]/g, '').slice(0,64) : null,
    position: Number.isFinite(event.position) ? Math.max(0, Math.floor(event.position)) : null,
    build: event.build || null, playback: event.playbackId || null,
    family: event.clientFamily || null, upfamily: event.upstreamFamily || null,
    latency, received: new Date().toISOString()
  };
}

async function persist(batch) {
  if (!batch.length) return;
  const devices = await query(BULK_SQL, { batch: JSON.stringify(batch) });
  for (const row of devices) touchDevice(row.device_id);
}

// API síncrona preservada para operações administrativas e testes.
export async function record(event) {
  if (!event?.activationId || !event?.source || !event?.state) return;
  await persist([normalize(event)]);
}

// Caminho quente: retorno HTTP independente de I/O de auditoria, sem abrir
// transação por request. Estados distintos de um mesmo aparelho são enviados
// em rodadas sucessivas, para não perder buffering->playing em poucos segundos.
const MAX_QUEUE = 12000;
const BATCH_SIZE = 250;
const FLUSH_MS = 1500;
const RETRY_MS = 5000;
const samples = new Map();
const pending = [];
let flushing = null;
let timer = null;
let lastWarning = 0;
let lost = 0;
const warned = (msg) => {
  if (Date.now() - lastWarning >= 60000) {
    lastWarning = Date.now();
    console.warn(`[connection-audit] ${msg}; fila=${pending.length}; descartados=${lost}`);
  }
};

function schedule(delay = FLUSH_MS) {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushAudit(); }, delay);
  timer.unref?.();
}

export function observe(event) {
  if (!event?.activationId || !event?.source || !event?.state) return false;
  const key = `${event.activationId}|${event.source}`;
  const signature = [event.state,event.statusCode,event.errorCode,event.transport,
    safeOrigin(event.origin),safeOrigin(event.selectedOrigin),event.playbackId].join('|');
  const now = Date.now();
  const last = samples.get(key);
  // Só os eventos originados no servidor são amostrados em 30s (HLS pode gerar
  // dezenas de segmentos). A TV envia estados a cada ~60s, sempre atualizados.
  if (event.source !== 'tv' && last?.signature === signature && now - last.at < 30000) return true;
  if (pending.length >= MAX_QUEUE) {
    // Prioriza falhas / alterações em detrimento de snapshots normais.
    const toEvict = pending.findIndex(e => ['playing', 'response', 'selected'].includes(e.state));
    if (toEvict >= 0) pending.splice(toEvict, 1);
    else { lost++; warned('limite de auditoria atingido'); return false; }
    lost++;
  }
  samples.delete(key);
  samples.set(key, { signature, at: now });
  if (samples.size > 12000) samples.delete(samples.keys().next().value);
  pending.push(normalize(event));
  schedule();
  // Lotes fixos e serializados. Não cria um Promise por request.
  if (pending.length >= BATCH_SIZE) void flushAudit();
  return true;
}

export async function flushAudit() {
  if (flushing) return flushing;
  flushing = (async () => {
    // Recorta um lote de até 250 registros, sem duplicar uma chave no UPSERT.
    while (pending.length) {
      const keys = new Set();
      const batch = [];
      for (let i = 0; i < pending.length && batch.length < BATCH_SIZE;) {
        const event = pending[i];
        const key = `${event.activation}|${event.source}`;
        if (keys.has(key)) { i++; continue; }
        keys.add(key);
        batch.push(event);
        pending.splice(i, 1);
      }
      try { await persist(batch); }
      catch (error) {
        pending.unshift(...batch);
        warned(`escrita em lote falhou (${error?.code || error?.name || 'DB_ERROR'})`);
        schedule(RETRY_MS);
        return;
      }
    }
  })().finally(() => { flushing = null; if (pending.length) schedule(RETRY_MS); });
  return flushing;
}

let cleanupTimer = null;
let cleaning = false;
export async function cleanupAudit() {
  if (cleaning) return;
  cleaning = true;
  try {
    // A limpeza precisa superar a produção mesmo com milhares de TVs. O índice
    // connection_retention existe na migration original; SKIP LOCKED evita concorrência.
    await sequelize.query(`DELETE FROM device_connection_events WHERE id IN
      (SELECT id FROM device_connection_events
        WHERE created_at < NOW()-INTERVAL '7 days'
        ORDER BY created_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`);
  } catch (e) { warned(`limpeza falhou (${e?.code || 'DB_ERROR'})`); }
  finally { cleaning = false; }
}
export function startAudit() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => { void cleanupAudit(); }, 15000);
  cleanupTimer.unref?.();
}
export async function stopAudit() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  await flushAudit();
}
export function auditQueueStats() { return { queued: pending.length, dropped: lost }; }

export function connectionObserver(ctx, req, selectedOrigin, providerId) {
  let last = { origin: selectedOrigin };
  return detail => {
    last = { ...last, ...detail };
    observe({ activationId: ctx.activationId || ctx.activation?.id,
      sessionId: ctx.sessionId || ctx.session?.id, source: 'server',
      selectedOrigin, providerId, clientFamily: ipFamily(req.ip), ...last });
  };
}

export async function readAudit(id, partnerId, before, beforeId) {
  const owner = await ownership(id);
  if (!canRead(owner, partnerId)) throw notFound('Dispositivo');
  const scope = partnerId ? ' AND (partner_id=:partner OR reseller_id=:partner)' : '';
  const replacements = { id, partner: partnerId || null,
    before: before || new Date().toISOString(),
    beforeId: beforeId || 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
  const base = `activation_id=:id AND created_at>NOW()-INTERVAL '7 days'${scope}`;
  const events = await query(`SELECT * FROM device_connection_events WHERE ${base}
    AND (created_at,id) < (:before,:beforeId)
    ORDER BY created_at DESC,id DESC LIMIT 51`, replacements);
  const latest = await query(`SELECT * FROM device_connection_latest
    WHERE activation_id=:id AND created_at>NOW()-INTERVAL '7 days'${scope} ORDER BY source`, replacements);
  const client = latest.find(e => e.source === 'tv');
  // Telemetria periódica passa a 55–65s. Duas perdas consecutivas tornam o estado antigo.
  let fresh = !!client && Date.now() - new Date(client.created_at).getTime() < 150000;
  if (fresh && client.session_id) {
    const sessions = await query(`SELECT id FROM device_sessions
      WHERE id=:sid AND revoked_at IS NULL AND expires_at>NOW()`, { sid: client.session_id });
    fresh = sessions.length > 0;
  }
  return { events: events.slice(0, 50),
    nextBefore: events.length > 50 ? { before: events[49].created_at, beforeId: events[49].id } : null,
    latest, playbackFresh: fresh, serverTime: new Date().toISOString(), retentionDays: 7 };
}
