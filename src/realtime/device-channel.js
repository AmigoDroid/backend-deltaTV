/**
 * DeltaTV: canal de controle/telemetria dos aparelhos.
 * Roku 16+: WebSocket TLS (roWebSocket).
 * Roku legado: HTTPS long-poll (NÃO é um WebSocket RFC 6455).
 * A transmissão de mídia NÃO passa por aqui.
 */
import { WebSocket, WebSocketServer } from 'ws';
import { Op } from 'sequelize';
import { Activation, DeviceSession } from '../db/models/index.js';
import { verifyJwt } from '../shared/crypto.js';
import { observe, ipFamily } from '../modules/connection-audit/service.js';
import { telemetrySchema } from '../modules/connection-audit/routes.js';
import { touchDevice } from '../modules/devices/presence.js';
import { env } from '../config/env.js';
import { publishDeviceChange } from './change-bus.js';
import { deviceOnline, livePlayback } from './live-snapshot.js';
import { isIP as checkIp } from 'node:net';

// Cabeçalho de IP somente é confiável quando a conexão vem do Nginx local.
function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (remote === '127.0.0.1' || remote === '::1') {
    const ip = String(req.headers['x-real-ip'] || '').trim();
    if (checkIp(ip)) return ip;
  }
  return checkIp(remote) ? remote : null;
}
const MAX_PEERS = Math.min(10000, Math.max(100, Number(process.env.DEVICE_WS_MAX_PEERS) || 5000));
const RECHECK_MS = 30000;
const MAX_PENDING_POLLS = Math.min(8000, Math.max(100, Number(process.env.DEVICE_POLL_MAX_WAITERS) || 4500));
const POLL_MS = 40000; // menos consultas de reautenticacao; Nginx timeout >= 60s
const peers = new Set();
const waiting = new Set();
const recent = [];
// Só metadados e RTT; não armazenar tokens, URL completa ou payload de mídia.
const deviceLinks = new Map();
const MAX_LINKS = 10000;
export function noteDeviceTransport(activationId, transport, build = '') {
  if (!activationId) return;
  const key = String(activationId);
  const current = deviceLinks.get(key) || { latencyMs: null, minMs: null, maxMs: null, samples: 0 };
  if (deviceLinks.size >= MAX_LINKS && !deviceLinks.has(key)) deviceLinks.delete(deviceLinks.keys().next().value);
  const actual = transport === 'https-legacy' && current.transport === 'wss' && Date.now() - (current.seenAt || 0) < 90000 ? 'wss' : transport;
  deviceLinks.set(key, { ...current, transport: actual, build: String(build || current.build || '').slice(0, 16), seenAt: Date.now() });
}
export function noteDeviceLatency(activationId, ms) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 30000 || !activationId) return;
  const key = String(activationId);
  const current = deviceLinks.get(key) || {};
  const value = Math.round(ms);
  deviceLinks.set(key, { ...current, latencyMs: value, minMs: Math.min(current.minMs ?? value, value),
    maxMs: Math.max(current.maxMs ?? value, value), samples: Math.min(1000000, (current.samples || 0) + 1),
    latencyAt: Date.now() });
}
export function transportForActivation(activationId) {
  const item = deviceLinks.get(String(activationId));
  if (!item) return { transport: 'unknown', connected: false, latencyMs: null, supported: false };
  const online = Date.now() - item.seenAt < (item.transport === 'wss' ? 100000 : 95000);
  return { transport: online ? item.transport : 'offline', connected: online,
    build: item.build || null, supported: Number(item.build || 0) >= 48,
    latencyMs: item.latencyAt && Date.now() - item.latencyAt < 300000 ? item.latencyMs : null,
    minMs: item.minMs ?? null, maxMs: item.maxMs ?? null, samples: item.samples || 0,
    lastSeenAt: new Date(item.seenAt).toISOString(), latencyMeasuredAt: item.latencyAt ? new Date(item.latencyAt).toISOString() : null,
    latencyMethod: item.transport === 'wss' ? 'WSS aplicação (RTT)' : 'HTTPS cliente (RTT)' };
}
let sequence = 0;
let rechecking = false;
let pendingAuth = 0;

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 16384) return false;
  ws.send(JSON.stringify(payload));
  return true;
}
function isRelevant(hint, activationId, partnerId) {
  if (hint.activationId && String(hint.activationId) !== String(activationId)) return false;
  if (hint.partnerId && String(hint.partnerId) !== String(partnerId)) return false;
  return true;
}
function hintPacket(hint) {
  return { type: hint.topic === 'remote-command' ? 'command-ready' : 'check-status',
    topic: hint.topic, scope: hint.priority === 'targeted' ? 'targeted' : 'global' };
}
function readHints(since, aid, partnerId) {
  const from = Number.isSafeInteger(since) && since >= 0 ? since : 0;
  if (recent.length && from > 0 && from < recent[0].seq - 1) return [{ type: 'check-status', topic: 'reconnect', scope: 'targeted' }];
  if (from > sequence) return [{ type: 'check-status', topic: 'reconnect', scope: 'targeted' }];
  return recent.filter(x => x.seq > from && isRelevant(x, aid, partnerId)).map(hintPacket);
}

export function broadcastDeviceHint({ topic = 'devices', activationId = null, partnerId = null, priority = null } = {}, propagate = true) {
  // The notification is a hint, never an authorization or a copy of a list.
  sequence++;
  const hint = { seq: sequence, topic: String(topic).slice(0, 32), activationId, partnerId,
    priority: priority || (activationId ? 'targeted' : 'global') };
  recent.push(hint);
  if (recent.length > 256) recent.shift();
  for (const peer of peers) if (isRelevant(hint, peer.activationId, peer.partnerId)) safeSend(peer.ws, hintPacket(hint));
  for (const waiter of [...waiting]) if (isRelevant(hint, waiter.activationId, waiter.partnerId)) waiter.finish();
  if (propagate) publishDeviceChange(hint);
}

export function currentSequence() { return sequence; }
export function currentDeviceChannelStats() { return { websocket: peers.size, waitingPolls: waiting.size, sequence }; }

/** Checa a sessão real no banco; o token de auditoria isoladamente não autoriza comandos. */
export async function authorizeDevice(token) {
  const claims = verifyJwt(token, 'telemetry');
  if (!claims.sid || !claims.aid) throw new Error('Invalid claims');
  const session = await DeviceSession.findByPk(claims.sid, {
    attributes: ['id', 'activationId', 'revokedAt', 'expiresAt'], raw: true,
  });
  if (!session || session.revokedAt || String(session.activationId) !== String(claims.aid) || new Date(session.expiresAt) <= new Date()) throw new Error('Revoked');
  const activation = await Activation.findByPk(claims.aid, { attributes: ['id', 'deviceId', 'partnerId'], raw: true });
  if (!activation?.deviceId) throw new Error('Invalid activation');
  return { sessionId: session.id, activationId: activation.id, deviceId: activation.deviceId, partnerId: activation.partnerId, tokenExp: claims.exp * 1000 };
}

export function observeSocketEvent(peer, packet, ip) {
  const validated = telemetrySchema.safeParse(packet?.payload);
  if (!validated.success) return false;
  const b = validated.data;
  livePlayback(peer.activationId, b, ip);
  return observe({
    activationId: peer.activationId, sessionId: peer.sessionId,
    source: 'tv', state: b.state, clientFamily: ipFamily(ip),
    origin: b.origin, playbackId: b.playback_id, position: b.position,
    errorCode: b.error_code, build: b.build,
  });
}

/** Serviço WebSocket somente para aparelhos; /ws dos painéis permanece intacto. */
export function createDeviceWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => {
    pendingAuth++;
    let peer = null;
    let pending = true;
    let authenticating = false;
    const timeout = setTimeout(() => { if (!peer) ws.close(1008, 'Authentication timeout'); }, 7000);
    const cleanup = () => { clearTimeout(timeout); if (pending) { pendingAuth--; pending = false; } if (peer) peers.delete(peer); peer = null; };
    ws.on('message', async (bytes, isBinary) => {
      if (isBinary) { ws.close(1003); return; }
      let msg;
      try { msg = JSON.parse(String(bytes)); } catch { ws.close(1008, 'Invalid message'); return; }
      if (!peer) {
        if (authenticating || msg?.type !== 'auth' || typeof msg.token !== 'string' || msg.token.length > 4096) { ws.close(1008, 'Auth required'); return; }
        authenticating = true;
        try {
          const auth = await authorizeDevice(msg.token);
          if (ws.readyState !== WebSocket.OPEN) return;
          peer = { ...auth, ws, alive: true, lastSeen: Date.now(), build: String(msg.build || '').slice(0,16), lastProbe: 0, pendingProbe: null };
          deviceOnline(peer.activationId, { ip: clientIp(req), launchId: msg.launchId, model: msg.model, osMajor: msg.osMajor });
          noteDeviceTransport(peer.activationId, 'wss', peer.build);
          peers.add(peer);
          if (pending) { pendingAuth--; pending = false; }
          touchDevice(peer.deviceId);
          clearTimeout(timeout);
          safeSend(ws, { type: 'ready', transport: 'websocket', heartbeatSeconds: 45, sequence });
          safeSend(ws, { type: 'command-ready' });
          safeSend(ws, { type: 'check-status', topic: 'reconnect', scope: 'targeted' });
        } catch { ws.close(1008, 'Unauthorized'); }
        return;
      }
      if (Date.now() >= peer.tokenExp) { ws.close(1008, 'Token expired'); return; }
      if (msg?.type === 'heartbeat') {
        // A sessão permanece online mesmo na Home, sem qualquer vídeo tocando.
        deviceOnline(peer.activationId, { ip: clientIp(req) });
        if (Date.now() - peer.lastSeen > 15000) { peer.lastSeen = Date.now(); touchDevice(peer.deviceId); noteDeviceTransport(peer.activationId, 'wss', peer.build); }
        safeSend(ws, { type: 'heartbeat-ack' });
      } else if (msg?.type === 'telemetry') {
        if (!observeSocketEvent(peer, msg, clientIp(req))) safeSend(ws, { type: 'telemetry-rejected' });
      } else if (msg?.type === 'latency-reply') {
        if (peer.pendingProbe && msg.nonce === peer.pendingProbe.nonce && Date.now() - peer.pendingProbe.sentAt < 30000) {
          noteDeviceLatency(peer.activationId, Date.now() - peer.pendingProbe.sentAt);
          peer.pendingProbe = null;
        }
      } else if (msg?.type !== 'ping') {
        ws.close(1008, 'Unsupported action');
      } else safeSend(ws, { type: 'pong' });
    });
    ws.on('pong', () => {
      if (peer) { peer.alive = true; deviceOnline(peer.activationId, { ip: clientIp(req) }); }
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
  const timer = setInterval(async () => {
    // Ping nativo WS para identificar links quebrados sem uma query por aparelho.
    for (const p of [...peers]) {
      if (p.ws.readyState !== WebSocket.OPEN || !p.alive || Date.now() >= p.tokenExp) { p.ws.terminate(); continue; }
      p.alive = false;
      try {
        p.ws.ping();
        if (Date.now() - p.lastProbe >= 120000) {
          const nonce = String(Date.now()) + ':' + Math.random().toString(36).slice(2, 12);
          p.pendingProbe = { nonce, sentAt: Date.now() };
          p.lastProbe = Date.now();
          safeSend(p.ws, { type: 'latency-probe', nonce });
        }
      } catch { p.ws.terminate(); }
    }
    if (rechecking) return;
    rechecking = true;
    try {
      const active = [...peers].filter(p => p.ws.readyState === WebSocket.OPEN);
      const ids = [...new Set(active.map(p => String(p.sessionId)))];
      const allowed = new Set();
      for (let i = 0; i < ids.length; i += 400) {
        const rows = await DeviceSession.findAll({
          where: { id: { [Op.in]: ids.slice(i, i + 400) }, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
          attributes: ['id'], raw: true,
        });
        for (const s of rows) allowed.add(String(s.id));
      }
      for (const p of active) if (!allowed.has(String(p.sessionId))) p.ws.close(1008, 'Session revoked');
    } catch (e) { console.warn('[device-ws] session recheck failed:', e.message); }
    finally { rechecking = false; }
  }, RECHECK_MS);
  timer.unref();
  return {
    handleUpgrade(req, socket, head) {
      if (peers.size >= MAX_PEERS || pendingAuth >= 250) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
      // Roku não envia Origin necessariamente; se houver Origin, aplicar política de browser.
      if (req.headers.origin && req.headers.origin !== env.publicBaseUrl && !env.corsOrigins.includes(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
    },
    stop() {
      clearInterval(timer);
      for (const waiter of [...waiting]) waiter.finish();
      for (const p of [...peers]) p.ws.close(1001, 'Server shutdown');
      wss.close();
    },
  };
}

/** Emulação segura em Roku legado. O GET fica aberto até 18s, sem consultas repetidas ao banco. */
export async function legacyPoll(req, res) {
  let auth;
  try {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer ')) throw new Error('Auth required');
    auth = await authorizeDevice(header.slice(7));
  } catch { res.status(401).set('Cache-Control', 'no-store').json({ ok: false, code: 'SESSION_REVOKED' }); return; }
  touchDevice(auth.deviceId);
  noteDeviceTransport(auth.activationId, 'https-legacy', req.query.build);
  deviceOnline(auth.activationId, { ip: req.ip, launchId: req.query.launchId, model: req.query.model, osMajor: Number(req.query.osMajor) });
  const requested = Number(req.query.since);
  const since = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  const hints = readHints(since, auth.activationId, auth.partnerId);
  res.set('Cache-Control', 'no-store, no-transform').set('X-Accel-Buffering', 'no');
  if (hints.length || waiting.size >= MAX_PENDING_POLLS) { res.json({ ok: true, sequence, hints }); return; }
  let done = false;
  const waiter = { activationId: auth.activationId, partnerId: auth.partnerId, finish: null };
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiting.delete(waiter);
    if (!res.destroyed && !res.writableEnded) res.json({ ok: true, sequence, hints: readHints(since, auth.activationId, auth.partnerId) });
  };
  const timer = setTimeout(finish, POLL_MS);
  waiter.finish = finish;
  waiting.add(waiter);
  res.on('close', () => { done = true; clearTimeout(timer); waiting.delete(waiter); });
}
