import { WebSocketServer, WebSocket } from "ws";
import { readHostMetrics } from "../modules/system/metrics.js";
import { AdminUser } from "../db/models/index.js";
import { verifyJwt } from "../shared/crypto.js";
import { env } from "../config/env.js";

const peers = new Set();
let wss;
const now = () => Date.now();
const emit = (socket, data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
import { canReceiveChange, sameSessionClaims } from "./routing-policy.js";
const allowed = (peer, partnerId) => canReceiveChange(peer.user, partnerId);
// Sessões HTTP revogadas são encerradas também no canal em tempo real.
export function disconnectAdminUser(userId) {
  for (const peer of [...peers]) if (String(peer.user.id) === String(userId)) peer.socket.close(1008, "Session revoked");
}
// Revalidação agrupada, sem uma consulta ao banco por cliente ou por evento.
async function verifyActivePeers() {
  const active = [...peers].filter(p => p.socket.readyState === WebSocket.OPEN);
  const ids = [...new Set(active.map(p => p.user.id))];
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const accounts = await AdminUser.findAll({ where: { id: chunk }, attributes: ["id", "role", "partnerId", "status", "tokenVersion"], raw: true });
    const byId = new Map(accounts.map(a => [String(a.id), a]));
    for (const peer of active) {
      if (!chunk.includes(peer.user.id)) continue;
      const a = byId.get(String(peer.user.id));
      if (!sameSessionClaims(a, peer)) peer.socket.close(1008, "Permissions changed");
    }
  }
}
const presence = (partnerId) => {
  for (const peer of peers) if (peer.user.role === "partner" && peer.user.partnerId === partnerId) return true;
  return false;
};
// Só metadados de invalidação: nenhum conteúdo financeiro, credencial ou cadastro é enviado por socket.
// Encerra sessões WebSocket de um parceiro excluído (inclusive abas já abertas).
export function disconnectPartner(partnerId) {
  for (const peer of [...peers]) if (peer.user.role === "partner" && String(peer.user.partnerId) === String(partnerId)) peer.socket.close(1008, "Account disabled");
}
export function livePartnerIds() {
  return [...new Set([...peers].filter((p) => p.user.role === "partner").map((p) => p.user.partnerId))];
}
export function isPartnerConnected(id) { return Boolean(id) && presence(id); }
export function onlinePartnerCount() { return livePartnerIds().length; }
// Só dispara invalidação, sem transportar mensagens privadas pelo WebSocket.
// No envio geral evita uma emissão por linha do PostgreSQL.
export function broadcastNotificationRefresh(partnerIds = null) {
  const target = partnerIds == null ? null : new Set(partnerIds.map(String));
  for (const peer of peers) {
    if (peer.user.role === "partner" && (target === null || target.has(String(peer.user.partnerId))))
      emit(peer.socket, { type: "notification" });
  }
}
export function broadcastPartnerNotification(partnerId, notificationId) {
  for (const peer of peers) {
    if (peer.user.role === "partner" && String(peer.user.partnerId) === String(partnerId))
      emit(peer.socket, { type: "notification", id: notificationId });
  }
}
export function broadcastChange({ partnerId = null, topic = "data" } = {}) {
  for (const peer of peers) {
    if (allowed(peer, partnerId)) emit(peer.socket, { type: "changed", topic, partnerId });
  }
}
// Contagem de aparelhos para os painéis administrativos, sem enviar dados de aparelhos.
export function broadcastDevicePresence(online, windowSeconds) {
  for (const peer of peers) {
    if (peer.user.role !== "partner") emit(peer.socket, { type: "device-presence", online, windowSeconds });
  }
}
function broadcastPresence(partnerId) {
  if (!partnerId) return;
  const online = presence(partnerId);
  const lastDisconnectedAt = online ? null : new Date().toISOString();
  // O horário de desconexão viaja só como metadado, sem informações sensíveis.
  for (const peer of peers) if (peer.user.role !== "partner") emit(peer.socket, {
    type: "partner-presence", partnerId, online, onlineCount: onlinePartnerCount(), lastDisconnectedAt,
  });
}
async function touch(user) {
  if (user.role !== "partner") return;
  // Escrita periódica, não a cada ping. Falhas da telemetria não afetam autenticação.
  try { await AdminUser.update({ lastActivityAt: new Date() }, { where: { id: user.id } }); }
  catch (err) { console.warn("[ws-presence]", err.message); }
}
export function attachRealtime(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    let pathname;
    try { pathname = new URL(req.url, "http://localhost").pathname; } catch { socket.destroy(); return; }
    if (pathname !== "/ws") { socket.destroy(); return; }
    if (!origin || !env.corsOrigins.includes(origin)) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => wss.emit("connection", client));
  });
  wss.on("connection", (socket) => {
    let peer = null;
    let lastTouch = 0;
    const timeout = setTimeout(() => { if (!peer) socket.close(1008, "Auth required"); }, 5000);
    const close = () => {
      clearTimeout(timeout);
      if (peer) {
        const user = peer.user;
        peers.delete(peer);
        if (user.role === "partner" && !presence(user.partnerId)) {
          // Uma escrita por desconexão final: permite estimar o tempo offline após recarregar a página.
          void touch(user);
        }
        broadcastPresence(user.partnerId);
        peer = null;
      }
    };
    socket.on("message", async (raw) => {
      let packet;
      try { packet = JSON.parse(String(raw)); } catch { socket.close(1008); return; }
      if (!peer) {
        if (packet?.type !== "auth" || typeof packet.token !== "string") { socket.close(1008); return; }
        try {
          const claims = verifyJwt(packet.token, "admin");
          const user = await AdminUser.findByPk(claims.sub);
          if (!user || user.status !== "active" || user.tokenVersion !== claims.tv || !["partner", "admin", "superadmin", "support"].includes(user.role) || (user.role === "partner" && !user.partnerId)) throw Error("Invalid account");
          if (socket.readyState !== WebSocket.OPEN) return;
          peer = { socket, user: { id: user.id, role: user.role, partnerId: user.partnerId }, tokenVersion: user.tokenVersion, exp: claims.exp, alive: true, systemMetricsSubscribed: false };
          peers.add(peer); clearTimeout(timeout);
          emit(socket, { type: "ready", role: user.role, ...(user.role !== "partner" ? { onlinePartnerIds: livePartnerIds(), onlinePartnerCount: onlinePartnerCount() } : {}) });
          if (user.role === "partner") { lastTouch = now(); void touch(peer.user); broadcastPresence(user.partnerId); }
        } catch { socket.close(1008, "Unauthorized"); }
        return;
      }
      if (packet?.type === "system-metrics-subscribe") {
        // Nunca expor o uso do host a administradores comuns ou revendas.
        if (peer.user.role !== "superadmin") { socket.close(1008, "Forbidden"); return; }
        peer.systemMetricsSubscribed = packet.enabled === true;
        if (peer.systemMetricsSubscribed) emit(socket, { type: "system-metrics", metrics: readHostMetrics() });
        return;
      }
      if (packet?.type === "heartbeat" && peer.user.role === "partner" && now() - lastTouch >= 60000) {
        lastTouch = now(); void touch(peer.user);
      }
    });
    socket.on("pong", () => { if (peer) peer.alive = true; });
    socket.on("close", close);
    socket.on("error", close);
  });
  // Uma única amostra para todos os superadmins inscritos, somente enquanto alguém observa a tela.
  const metricsTimer = setInterval(() => {
    const subscribers = [...peers].filter((p) => p.systemMetricsSubscribed && p.user.role === "superadmin" && p.socket.readyState === WebSocket.OPEN);
    if (!subscribers.length) return;
    const packet = { type: "system-metrics", metrics: readHostMetrics() };
    for (const peer of subscribers) {
      if (peer.socket.bufferedAmount < 16 * 1024) emit(peer.socket, packet);
    }
  }, 5000);
  metricsTimer.unref();
  const timer = setInterval(() => {
    for (const peer of [...peers]) {
      if (peer.exp * 1000 <= now() || !peer.alive) { peer.socket.terminate(); continue; }
      peer.alive = false; peer.socket.ping();
    }
  }, 30000);
  timer.unref();
  const revocationTimer = setInterval(() => {
    void verifyActivePeers().catch(err => console.warn("[ws-auth] Falha de revalidação:", err.message));
  }, 60000);
  revocationTimer.unref();
  return () => { clearInterval(revocationTimer); clearInterval(timer); clearInterval(metricsTimer); for (const peer of [...peers]) peer.socket.close(1001); wss.close(); };
}
