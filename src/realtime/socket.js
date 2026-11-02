import { WebSocketServer, WebSocket } from "ws";
import { AdminUser } from "../db/models/index.js";
import { verifyJwt } from "../shared/crypto.js";
import { env } from "../config/env.js";

const peers = new Set();
let wss;
const now = () => Date.now();
const emit = (socket, data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
const allowed = (peer, partnerId) => peer.user.role !== "partner" || (partnerId && String(peer.user.partnerId) === String(partnerId));
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
          peer = { socket, user: { id: user.id, role: user.role, partnerId: user.partnerId }, exp: claims.exp, alive: true };
          peers.add(peer); clearTimeout(timeout);
          emit(socket, { type: "ready", role: user.role, ...(user.role !== "partner" ? { onlinePartnerIds: livePartnerIds(), onlinePartnerCount: onlinePartnerCount() } : {}) });
          if (user.role === "partner") { lastTouch = now(); void touch(peer.user); broadcastPresence(user.partnerId); }
        } catch { socket.close(1008, "Unauthorized"); }
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
  const timer = setInterval(() => {
    for (const peer of [...peers]) {
      if (peer.exp * 1000 <= now() || !peer.alive) { peer.socket.terminate(); continue; }
      peer.alive = false; peer.socket.ping();
    }
  }, 30000);
  timer.unref();
  return () => { clearInterval(timer); for (const peer of [...peers]) peer.socket.close(1001); wss.close(); };
}
