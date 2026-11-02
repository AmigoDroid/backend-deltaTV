import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { env } from "../../config/env.js";

// Consulta somente metadados de saúde já produzidos pelo monitor de fundo.
// Nenhuma sondagem de rede acontece ao carregar a página.
const INTERVAL = Math.max(30, Math.min(3600, Number(process.env.PROVIDER_MONITOR_INTERVAL_SECONDS) || 60));
const MAX_PER_CYCLE = Math.max(5, Math.min(250, Number(process.env.PROVIDER_MONITOR_MAX_PER_CYCLE) || 60));
const enabled = () => env.enableScheduler && process.env.PROVIDER_MONITOR_ENABLED === "true";
const DEFAULT_PAGE_SIZE = 20;
const SLOW_MS = Math.max(300, Math.min(5000, Number(process.env.PROVIDER_MONITOR_SLOW_MS) || 2500));
// Uma única contagem global por minuto, compartilhada por todas as sessões de revenda.
// Assim a janela de validade acompanha o número real de servidores monitorados, sem uma COUNT por usuário.
let activeCountCache = { until: 0, value: null, pending: null };
export async function freshnessWindowSeconds() {
  if (!enabled()) return 180;
  const now = Date.now();
  if (activeCountCache.value !== null && activeCountCache.until > now) {
    return Math.max(180, Math.min(3600, INTERVAL * (Math.ceil(activeCountCache.value / MAX_PER_CYCLE) + 2)));
  }
  if (!activeCountCache.pending) {
    activeCountCache.pending = sequelize.query(
      "SELECT count(*)::integer AS total FROM partner_providers WHERE status = 'active'",
      { type: QueryTypes.SELECT },
    ).then(([row]) => {
      activeCountCache.value = Number(row?.total) || 0;
      activeCountCache.until = Date.now() + 60000;
      return activeCountCache.value;
    }).finally(() => { activeCountCache.pending = null; });
  }
  const total = await activeCountCache.pending;
  return Math.max(180, Math.min(3600, INTERVAL * (Math.ceil(total / MAX_PER_CYCLE) + 2)));
}

const healthState = `CASE
  WHEN pp.status <> 'active' THEN 'disabled'
  WHEN :monitorEnabled = false THEN 'unknown'
  WHEN ph.last_checked_at IS NULL OR ph.last_checked_at < :freshAfter THEN 'unknown'
  WHEN ph.state = 'healthy' THEN 'healthy'
  WHEN ph.state = 'slow' THEN 'slow'
  WHEN ph.state = 'down' THEN 'down'
  WHEN ph.state IN ('checking', 'suspect') THEN 'suspect'
  ELSE 'unknown'
END`;

/** Consulta paginada; escopo de revenda vem sempre do JWT, nunca da query enviada pelo navegador. */
export async function listServerHealth({ partnerId = null, q = "", status = "", page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const monitorEnabled = enabled();
  const size = Math.max(1, Math.min(50, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const currentPage = Math.max(1, Math.min(100000, Number(page) || 1));
  // Ao monitorar milhares de origens, não declarar queda por medição antiga.
  // Uma volta completa de sondagens pode demorar mais do que o intervalo base.
  const freshnessSeconds = await freshnessWindowSeconds();
  const replacements = {
    partnerId, monitorEnabled, freshAfter: new Date(Date.now() - freshnessSeconds * 1000),
    pattern: `%${String(q || "").trim().replace(/[\\%_]/g, "\\$&")}%`,
    status, limit: size, offset: (currentPage - 1) * size,
  };
  const conditions = [];
  if (partnerId) conditions.push("pp.partner_id = :partnerId");
  if (q) conditions.push("(pp.name ILIKE :pattern ESCAPE '\\' OR pp.base_url ILIKE :pattern ESCAPE '\\' OR p.name ILIKE :pattern ESCAPE '\\')");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const source = `FROM partner_providers pp
    LEFT JOIN partners p ON p.id = pp.partner_id
    LEFT JOIN provider_health ph ON ph.provider_id = pp.id ${where}`;
  // Status calculado em SQL: paginação, filtros e totais usam exatamente a mesma regra.
  const base = `WITH servers AS (
    SELECT pp.id, pp.partner_id AS "partnerId", p.name AS "partnerName", pp.name,
      pp.base_url AS "baseUrl", pp.priority, pp.status AS "configuredStatus",
      ph.latency_ms AS "latencyMs", ph.last_checked_at AS "lastCheckedAt",
      ph.last_good_at AS "lastGoodAt", ph.last_error AS "lastError",
      ${healthState} AS health_status ${source}
  )`;
  const statusFilter = status ? "WHERE health_status = :status" : "";
  const [rows, aggregates] = await Promise.all([
    sequelize.query(`${base} SELECT *, health_status AS "healthStatus" FROM servers ${statusFilter}
      ORDER BY CASE health_status WHEN 'down' THEN 0 WHEN 'suspect' THEN 1 WHEN 'slow' THEN 2 WHEN 'unknown' THEN 3 WHEN 'healthy' THEN 4 ELSE 4 END,
        "partnerName" ASC NULLS LAST, name ASC, id ASC LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT }),
    sequelize.query(`${base} SELECT health_status, count(*)::integer AS total FROM servers GROUP BY health_status`,
      { replacements, type: QueryTypes.SELECT }),
  ]);
  const summary = { total: 0, healthy: 0, slow: 0, suspect: 0, down: 0, unknown: 0, disabled: 0 };
  for (const r of aggregates) {
    if (Object.hasOwn(summary, r.health_status)) summary[r.health_status] = Number(r.total);
    summary.total += Number(r.total);
  }
  const count = status ? (summary[status] || 0) : summary.total;
  return {
    monitorEnabled, intervalSeconds: INTERVAL, freshnessSeconds,
    lastSnapshotAt: new Date().toISOString(), summary, rows, count,
    page: currentPage, pageSize: size, pages: Math.max(1, Math.ceil(count / size)),
  };
}


// Cache pequeno e limitado por parceria para evitar uma query por navegador a cada abertura.
// Quando o monitor detecta mudança, ele invalida o parceiro ANTES de emitir o WebSocket.
const alertCache = new Map();
const MAX_ALERT_CACHE = 500;
export function invalidatePartnerServerAlerts(partnerId) {
  if (partnerId) alertCache.delete(String(partnerId));
}

/** Resumo leve para a faixa de alerta no portal: somente servidores desta parceria.
 * Nunca realiza sondagens e nunca devolve URLs completas, tokens ou credenciais.
 * A janela de validade evita alarmes baseados em medições antigas.
 */
export async function getPartnerServerAlerts(partnerId) {
  if (!enabled()) return { monitorEnabled: false, thresholdMs: SLOW_MS, total: 0, slow: 0, down: 0, unstable: 0, items: [] };
  const key = String(partnerId);
  const cached = alertCache.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const pending = fetchPartnerServerAlerts(partnerId);
  // Cacheia também a promise para agrupar requisições concorrentes.
  alertCache.delete(key);
  if (alertCache.size >= MAX_ALERT_CACHE) alertCache.delete(alertCache.keys().next().value);
  alertCache.set(key, { until: Date.now() + 15000, value: pending });
  pending.catch(() => { if (alertCache.get(key)?.value === pending) alertCache.delete(key); });
  return pending;
}

async function fetchPartnerServerAlerts(partnerId) {
  const freshSeconds = await freshnessWindowSeconds();
  const rows = await sequelize.query(`WITH problems AS (
    SELECT pp.id, pp.name, pp.base_url AS "baseUrl",
      ph.latency_ms AS "latencyMs", ph.last_checked_at AS "lastCheckedAt",
      CASE
        WHEN ph.last_error = 'Resposta lenta' THEN 'slow'
        WHEN ph.state = 'down' THEN 'down'
        WHEN ph.latency_ms >= :slowMs THEN 'slow'
        ELSE 'unstable'
      END AS kind
    FROM partner_providers pp
    JOIN provider_health ph ON ph.provider_id = pp.id
    WHERE pp.partner_id = :partnerId AND pp.status = 'active'
      AND ph.last_checked_at >= :freshAfter
      AND (ph.state IN ('down', 'suspect', 'slow') OR ph.latency_ms >= :slowMs)
  )
  SELECT *, count(*) OVER ()::integer AS total,
    count(*) FILTER (WHERE kind = 'slow') OVER ()::integer AS slow,
    count(*) FILTER (WHERE kind = 'down') OVER ()::integer AS down,
    count(*) FILTER (WHERE kind = 'unstable') OVER ()::integer AS unstable
  FROM problems
  ORDER BY CASE kind WHEN 'down' THEN 0 WHEN 'slow' THEN 1 ELSE 2 END,
    "latencyMs" DESC NULLS LAST, name ASC, id ASC
  LIMIT 3`, {
    replacements: { partnerId, slowMs: SLOW_MS, freshAfter: new Date(Date.now() - freshSeconds * 1000) },
    type: QueryTypes.SELECT,
  });
  const first = rows[0];
  return {
    monitorEnabled: true, thresholdMs: SLOW_MS,
    total: Number(first?.total) || 0,
    slow: Number(first?.slow) || 0,
    down: Number(first?.down) || 0,
    unstable: Number(first?.unstable) || 0,
    items: rows.map(r => {
      let host = 'Endereço não identificado';
      try { host = new URL(r.baseUrl).host; } catch { /* URL legada inválida */ }
      return { id: r.id, name: r.name, host, latencyMs: r.latencyMs, lastCheckedAt: r.lastCheckedAt, kind: r.kind };
    }),
  };
}
