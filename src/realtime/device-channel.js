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

const MAX_PEERS = Math.min(10000, Math.max(100, Number(process.env.DEVICE_WS_MAX_PEERS) || 5000));
const RECHECK_MS = 30000;
const MAX_PENDING_POLLS = Math.min(8000, Math.max(100, Number(process.env.DEVICE_POLL_MAX_WAITERS) || 4500));
const POLL_MS = 40000; // menos consultas de reautenticacao; Nginx timeout >= 60s
const peers = new Set();
const waiting = new Set();
const recent = [];
let sequence = 0;
let rechecking = false;
let pendingAuth = 0;

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 16384) return false;
  ws.send(JSON.stringify(payload));
  return true;
}
function isRelevant(hint, activationId) {
  return !hint.activationId || String(hint.activationId) === String(activationId);
}
function readHints(since, aid) {
  const from = Number.isSafeInteger(since) && since >= 0 ? since : 0;
  // Se um cliente perdeu a janela do histórico (ou o servidor reiniciou),
  // solicita checagem do estado por HTTPS, em vez de presumir que nada mudou.
  if (recent.length && from > 0 && from < recent[0].seq - 1) return [{ type: 'check-status' }];
  if (from > sequence) return [{ type: 'check-status' }];
  return recent.filter(x => x.seq > from && isRelevant(x, aid)).map(x => ({ type: 'check-status', topic: x.topic }));
}

export function broadcastDeviceHint({ topic = 'devices', activationId = null } = {}) {
  // Avisos são somente invalidação; sem URL, senha, credencial ou dados pessoais.
  sequence++;
  const hint = { seq: sequence, topic: String(topic).slice(0, 32), activationId };
  recent.push(hint);
  if (recent.length > 256) recent.shift();
  for (const peer of peers) if (isRelevant(hint, peer.activationId)) safeSend(peer.ws, { type: 'check-status', topic: hint.topic });
  for (const waiter of [...waiting]) if (isRelevant(hint, waiter.activationId)) waiter.finish();
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
  const activation = await Activation.findByPk(claims.aid, { attributes: ['id', 'deviceId'], raw: true });
  if (!activation?.deviceId) throw new Error('Invalid activation');
  return { sessionId: session.id, activationId: activation.id, deviceId: activation.deviceId, tokenExp: claims.exp * 1000 };
}

export function observeSocketEvent(peer, packet, ip) {
  const validated = telemetrySchema.safeParse(packet?.payload);
  if (!validated.success) return false;
  const b = validated.data;
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
          peer = { ...auth, ws, alive: true, lastSeen: Date.now() };
          peers.add(peer);
          if (pending) { pendingAuth--; pending = false; }
          touchDevice(peer.deviceId);
          clearTimeout(timeout);
          safeSend(ws, { type: 'ready', transport: 'websocket', heartbeatSeconds: 45, sequence });
        } catch { ws.close(1008, 'Unauthorized'); }
        return;
      }
      if (Date.now() >= peer.tokenExp) { ws.close(1008, 'Token expired'); return; }
      if (msg?.type === 'heartbeat') {
        if (Date.now() - peer.lastSeen > 15000) { peer.lastSeen = Date.now(); touchDevice(peer.deviceId); }
        safeSend(ws, { type: 'heartbeat-ack' });
      } else if (msg?.type === 'telemetry') {
        if (!observeSocketEvent(peer, msg, req.socket.remoteAddress)) safeSend(ws, { type: 'telemetry-rejected' });
      } else if (msg?.type !== 'ping') {
        ws.close(1008, 'Unsupported action');
      } else safeSend(ws, { type: 'pong' });
    });
    ws.on('pong', () => { if (peer) peer.alive = true; });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });
  const timer = setInterval(async () => {
    // Ping nativo WS para identificar links quebrados sem uma query por aparelho.
    for (const p of [...peers]) {
      if (p.ws.readyState !== WebSocket.OPEN || !p.alive || Date.now() >= p.tokenExp) { p.ws.terminate(); continue; }
      p.alive = false;
      try { p.ws.ping(); } catch { p.ws.terminate(); }
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
  const requested = Number(req.query.since);
  const since = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  const hints = readHints(since, auth.activationId);
  res.set('Cache-Control', 'no-store, no-transform').set('X-Accel-Buffering', 'no');
  if (hints.length || waiting.size >= MAX_PENDING_POLLS) { res.json({ ok: true, sequence, hints }); return; }
  let done = false;
  const waiter = { activationId: auth.activationId, finish: null };
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    waiting.delete(waiter);
    if (!res.destroyed && !res.writableEnded) res.json({ ok: true, sequence, hints: readHints(since, auth.activationId) });
  };
  const timer = setTimeout(finish, POLL_MS);
  waiter.finish = finish;
  waiting.add(waiter);
  res.on('close', () => { done = true; clearTimeout(timer); waiting.delete(waiter); });
}
