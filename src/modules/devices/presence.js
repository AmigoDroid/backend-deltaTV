import { sequelize } from "../../db/sequelize.js";
import { env } from "../../config/env.js";

/**
 * Presença (online/offline) de dispositivos — mecanismo leve, sem tabela nova e sem conexão persistente.
 *
 * Como funciona
 *  - "Online" = o aparelho deu sinal de vida nos últimos PRESENCE_WINDOW_SECONDS (padrão 90 s).
 *  - Sinal de vida = qualquer requisição autenticada do aparelho (API do cliente, token de reprodução, rota espelho Xtream)
 *    OU o heartbeat explícito (POST /api/v1/client/heartbeat), que cobre o aparelho parado num menu ou assistindo a uma
 *    conexão longa sem novas requisições.
 *  - Cada sinal só escreve em um Map em memória (O(1), sem I/O). A cada PRESENCE_FLUSH_SECONDS (padrão 15 s) os ids "sujos"
 *    são gravados de uma vez em devices.last_seen_at (UM UPDATE em lote). Resultado: milhares de TVs = 1 query a cada 15 s.
 *  - Leitura: usa o maior entre a memória deste processo (mais fresca) e o valor do banco (vale para várias instâncias).
 *
 * Limites assumidos (por desenho): com várias instâncias da API, o banco enxerga o sinal com atraso de até PRESENCE_FLUSH_SECONDS;
 * por isso a janela deve ser maior que (intervalo do heartbeat + flush). Um reinício perde, no máximo, um ciclo de flush
 * (stopPresence() faz um flush final no desligamento normal).
 */

const MAX_TRACKED = 100_000;
const BATCH = 1000;

const seen = new Map(); // deviceId -> epoch ms do último sinal
const dirty = new Set(); // deviceIds ainda não gravados no banco
let timer = null;
let flushing = null;

const windowMs = () => env.presenceWindowSeconds * 1000;

/** Registra que o aparelho está vivo agora. Barato: só memória. */
export function touchDevice(deviceId, now = Date.now()) {
  if (!deviceId) return;
  seen.set(deviceId, now);
  dirty.add(deviceId);
  if (seen.size > MAX_TRACKED) prune(now); // teto de memória
}

const toMs = (v) => (v == null ? null : new Date(v).getTime());

/** Puro: o instante está dentro da janela? */
export function isOnline(lastSeen, { now = Date.now(), window = windowMs() } = {}) {
  const t = toMs(lastSeen);
  return t != null && Number.isFinite(t) && now - t <= window;
}

/** Combina o valor do banco com a memória deste processo. Devolve { online, lastSeenAt }. */
export function presenceOf(deviceId, dbLastSeen, opts = {}) {
  const mem = deviceId ? seen.get(deviceId) : undefined;
  const db = toMs(dbLastSeen);
  const best = Math.max(mem ?? -Infinity, db ?? -Infinity);
  if (!Number.isFinite(best)) return { online: false, lastSeenAt: null };
  return { online: isOnline(best, opts), lastSeenAt: new Date(best) };
}

/** Condição SQL "online" para a coluna last_seen_at do alias informado. `window` vem do env (inteiro) — sem injeção. */
export function onlineSql(alias = "Device", online = true) {
  const col = `"${alias}"."last_seen_at"`;
  const cutoff = `now() - (${Math.trunc(env.presenceWindowSeconds)} * interval '1 second')`;
  return online ? `${col} >= ${cutoff}` : `(${col} IS NULL OR ${col} < ${cutoff})`;
}

/** Quantos aparelhos estão online agora (leitura do banco; leva em conta o flush mais recente). */
export async function countOnline() {
  const [rows] = await sequelize.query(
    `SELECT count(*)::int AS n FROM devices WHERE last_seen_at >= now() - (:w * interval '1 second')`,
    { replacements: { w: env.presenceWindowSeconds } },
  );
  return rows[0]?.n ?? 0;
}

function prune(now = Date.now()) {
  const limit = now - windowMs() * 2;
  for (const [id, t] of seen) if (t < limit && !dirty.has(id)) seen.delete(id);
  // Ainda acima do teto (rajada enorme): descarta os mais antigos já gravados.
  if (seen.size > MAX_TRACKED) for (const id of seen.keys()) { if (!dirty.has(id)) seen.delete(id); if (seen.size <= MAX_TRACKED) break; }
}

/** Grava os sinais pendentes. Nunca lança: em falha, devolve os ids à fila para a próxima rodada. */
export function flushPresence() {
  if (flushing) return flushing;
  flushing = (async () => {
    const ids = [...dirty];
    if (!ids.length) { prune(); return 0; }
    dirty.clear();
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const part = ids.slice(i, i + BATCH);
        const stamps = part.map((id) => new Date(seen.get(id) ?? Date.now()).toISOString());
        try {
          await sequelize.query(
            `UPDATE devices d SET last_seen_at = v.ts
               FROM unnest(ARRAY[:ids]::uuid[], ARRAY[:stamps]::timestamptz[]) AS v(id, ts)
              WHERE d.id = v.id AND (d.last_seen_at IS NULL OR d.last_seen_at < v.ts)`,
            { replacements: { ids: part, stamps } },
          );
        } catch (e) {
          part.forEach((id) => dirty.add(id));
          ids.slice(i + BATCH).forEach((id) => dirty.add(id));
          console.error("[presence] falha ao gravar:", e.message);
          return 0;
        }
      }
      prune();
      return ids.length;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export function startPresence() {
  if (timer) return;
  timer = setInterval(() => { flushPresence(); }, env.presenceFlushSeconds * 1000);
  timer.unref();
}

export async function stopPresence() {
  if (timer) clearInterval(timer);
  timer = null;
  await flushPresence();
}

// Somente testes.
export const _resetPresence = () => { seen.clear(); dirty.clear(); };
export const _dirtySize = () => dirty.size;
