/** Realtime invalidation fan-out between PM2 workers using PostgreSQL LISTEN/NOTIFY.
 * Events carry no tokens, credentials, media URLs, device MAC or customer data.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sequelize } from '../db/sequelize.js';
import { env } from '../config/env.js';

const CHANNEL = 'deltatv_device_change_v1';
const origin = randomUUID();
let listener = null;
let reconnect = null;
let closed = false;
let onEvent = null;
let retryMs = 3000;
const pending = new Set();
export function startDeviceChangeBus(receiver) {
  onEvent = receiver;
  closed = false;
  void connect();
}
async function connect() {
  if (closed || listener) return;
  const client = new pg.Client({ connectionString: env.databaseUrl,
    ssl: env.dbSsl ? { rejectUnauthorized: env.dbSslStrict } : false,
    application_name: 'deltatv-ws-events' });
  listener = client;
  client.on('notification', ({ channel, payload }) => {
    if (channel !== CHANNEL) return;
    try {
      const msg = JSON.parse(payload);
      if (msg.origin === origin || typeof msg.topic !== 'string' || msg.topic.length > 32) return;
      if (msg.activationId != null && !/^[0-9a-f-]{36}$/i.test(msg.activationId)) return;
      if (msg.partnerId != null && !/^[0-9a-f-]{36}$/i.test(msg.partnerId)) return;
      onEvent?.({ topic: msg.topic, activationId: msg.activationId ?? null,
        partnerId: msg.partnerId ?? null,
        priority: msg.priority === 'targeted' ? 'targeted' : 'global' });
    } catch { /* malformed notifications ignored */ }
  });
  const lost = () => {
    if (listener !== client) return;
    listener = null;
    client.end().catch(() => {});
    if (!closed && !reconnect) {
      reconnect = setTimeout(() => { reconnect = null; void connect(); }, retryMs);
      reconnect.unref?.();
      retryMs = Math.min(30000, retryMs * 2);
    }
  };
  client.on('error', lost);
  client.on('end', lost);
  try { await client.connect(); await client.query(`LISTEN ${CHANNEL}`); retryMs = 3000; }
  catch (err) { console.warn('[device-change-bus] LISTEN unavailable:', err.message); lost(); }
}
export function publishDeviceChange({ topic, activationId = null, partnerId = null, priority = 'global' }) {
  if (closed) return;
  const payload = JSON.stringify({ origin, topic: String(topic).slice(0, 32),
    activationId, partnerId, priority: priority === 'targeted' ? 'targeted' : 'global' });
  const op = sequelize.query('SELECT pg_notify(:channel, :payload)',
    { replacements: { channel: CHANNEL, payload } })
    .catch(err => console.warn('[device-change-bus] NOTIFY unavailable:', err.message))
    .finally(() => pending.delete(op));
  pending.add(op);
}
export async function stopDeviceChangeBus() {
  closed = true;
  clearTimeout(reconnect);
  reconnect = null;
  const old = listener; listener = null;
  try { await old?.end(); } catch {}
  await Promise.allSettled([...pending]);
}
