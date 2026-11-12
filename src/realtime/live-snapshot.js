/**
 * Estado operacional EFÊMERO. Nunca persistir IP, títulos ou hábitos de reprodução.
 * O identificador de ativação é obtido do token autenticado, jamais do payload.
 * Dados desaparecem quando a sessão fica inativa ou o processo reinicia.
 */
import { isIP } from 'node:net';
const MAX = 6500;
const FRESH_MS = 150_000;
const KEEP_MS = 8 * 86400000;
const devices = new Map();

const cleanIp = value => {
  const s = String(value || '').replace(/^::ffff:/, '');
  return isIP(s) ? s : null;
};
const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const numeric = (value, max) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : null;

function entry(id, now) {
  const key = String(id);
  let row = devices.get(key);
  if (!row) {
    if (devices.size >= MAX) {
      // Preferir descartar sessões mais antigas, nunca deixar memória crescer sem limite.
      let victim;
      for (const [candidate, r] of devices) if (!victim || r.seenAt < victim[1].seenAt) victim = [candidate, r];
      if (victim) devices.delete(victim[0]);
    }
    row = { seenAt: now, launchAt: now, launchId: null, playbackId: null,
      state: 'idle', watchStartedAt: null, watchingSeconds: 0, lastEventAt: null, playbackCounted: false, sessions: [] };
    devices.set(key, row);
  }
  return row;
}

export function deviceOnline(id, { ip, launchId, model, osMajor } = {}) {
  if (!id) return;
  const now = Date.now();
  const row = entry(id, now);
  row.seenAt = now;
  if (cleanIp(ip)) row.ip = cleanIp(ip);
  if (typeof model === 'string') row.model = bounded(model, 40);
  if (Number.isSafeInteger(osMajor) && osMajor >= 0 && osMajor <= 100) row.osMajor = osMajor;
  // UUID recebido da inicialização Roku, não de cada reconexão TCP.
  if (typeof launchId === 'string' && /^[a-f\d-]{36}$/i.test(launchId) && row.launchId !== launchId) {
    row.launchId = launchId;
    row.launchAt = now;
    // Nova abertura: nunca reutilizar o título/estado da execução anterior.
    row.playbackId = null;
    row.playbackCounted = false;
    row.watchStartedAt = null;
    row.lastEventAt = null;
    row.reportedAt = null;
    row.title = null;
    row.state = 'idle';
  }
}

export function livePlayback(id, info, ip) {
  if (!id || !info || typeof info !== 'object') return;
  deviceOnline(id, { ip });
  const now = Date.now();
  const row = entry(id, now);
  const playbackId = bounded(info.playback_id, 40);
  if (playbackId && row.playbackId !== playbackId) {
    row.playbackId = playbackId;
    row.watchStartedAt = null;
    row.playbackCounted = false;
    row.lastEventAt = null;
  }
  if (row.state === 'playing' && row.lastEventAt) {
    // Só o tempo entre amostras onde o player estava tocando; não conta pausa ou
    // horas offline. Cap de 120s protege contra filas retidas e suspensão de app.
    row.watchingSeconds += Math.min(120, Math.max(0, Math.floor((now-row.lastEventAt)/1000)));
  }
  if (info.state === 'playing' && !row.playbackCounted) {
    row.playbackCounted = true;
    row.watchStartedAt = now;
    row.sessions.push(now);
    row.sessions = row.sessions.filter(t => now - t < KEEP_MS).slice(-400);
  }
  row.lastEventAt = now;
  // No servidor o estado é transitório; NÃO gravar títulos ou IP em PostgreSQL.
  row.state = info.state;
  row.title = bounded(info.title, 140) || null;
  row.kind = ['live', 'movie', 'series'].includes(info.kind) ? info.kind : 'unknown';
  row.positionSeconds = numeric(info.position, 2147483647);
  row.durationSeconds = numeric(info.duration, 2147483647);
  row.bitrateKbps = numeric(info.bitrate_kbps, 100000);
  row.startupMs = numeric(info.startup_ms, 600000);
  row.bufferPercent = numeric(info.buffer_percent, 100);
  row.reportedAt = now;
  row.build = bounded(info.build, 16);
  if (['stopped', 'finished', 'error'].includes(row.state)) { row.watchStartedAt = null; }
}

export function liveForDevice(id) {
  const now = Date.now();
  const row = devices.get(String(id));
  if (!row) return { online: false, state: 'offline', source: 'memory', retention: 'ephemeral' };
  const online = now - row.seenAt <= FRESH_MS;
  const playing = online && row.reportedAt && now - row.reportedAt <= FRESH_MS && ['playing','paused','buffering','opening'].includes(row.state);
  const lastDay = row.sessions.filter(t => now - t < 86400000).length;
  const week = row.sessions.filter(t => now - t < 7*86400000).length;
  return {
    online, source: 'memory', retention: 'ephemeral',
    ip: online ? row.ip || null : null,
    rokuModel: online ? row.model || null : null, rokuOsMajor: online ? row.osMajor ?? null : null,
    appActiveSeconds: online ? Math.max(0, Math.floor((now - row.launchAt) / 1000)) : null,
    playback: playing ? { title: row.title, type: row.kind, state: row.state,
      positionSeconds: row.positionSeconds, durationSeconds: row.durationSeconds,
      bitrateKbps: row.bitrateKbps, startupMs: row.startupMs,
      bufferPercent: row.bufferPercent, since: row.watchStartedAt ? new Date(row.watchStartedAt).toISOString() : null } : null,
    usage: { sessions24h: lastDay, sessions7d: week,
      observedWatchSeconds: row.watchingSeconds + (playing && row.state === 'playing' && row.lastEventAt ? Math.min(120, Math.floor((now - row.lastEventAt)/1000)) : 0),
      coverage: 'somente enquanto este processo esteve ativo' },
    lastSeenAt: new Date(row.seenAt).toISOString(),
  };
}

/** Na ausência de Redis, 1 processo PM2 é necessário para painel completo. */
export function cleanLiveSnapshots() {
  const now = Date.now();
  for (const [id, item] of devices) {
    if (now - item.seenAt > KEEP_MS) { devices.delete(id); continue; }
    // IP e título devem desaparecer poucos minutos após o último sinal.
    if (now - item.seenAt > FRESH_MS) { item.ip = null; item.title = null; }
  }
}
const cleanup = setInterval(cleanLiveSnapshots, 600000);
cleanup.unref?.();
