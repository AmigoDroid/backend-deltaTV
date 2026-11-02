import { QueryTypes } from "sequelize";
import { sequelize } from "../../db/models/index.js";
import { env } from "../../config/env.js";

// Consulta somente metadados de saúde já produzidos pelo monitor de fundo.
// Nenhuma sondagem de rede acontece ao carregar a página.
const INTERVAL = Math.max(30, Math.min(3600, Number(process.env.PROVIDER_MONITOR_INTERVAL_SECONDS) || 60));
const MAX_PER_CYCLE = Math.max(5, Math.min(250, Number(process.env.PROVIDER_MONITOR_MAX_PER_CYCLE) || 60));
const enabled = () => env.enableScheduler && process.env.PROVIDER_MONITOR_ENABLED === "true";
const DEFAULT_PAGE_SIZE = 20;

const healthState = `CASE
  WHEN pp.status <> 'active' THEN 'disabled'
  WHEN :monitorEnabled = false THEN 'unknown'
  WHEN ph.last_checked_at IS NULL OR ph.last_checked_at < :freshAfter THEN 'unknown'
  WHEN ph.state = 'healthy' THEN 'healthy'
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
  const [activeCount] = await sequelize.query(
    "SELECT count(*)::integer AS total FROM partner_providers WHERE status = 'active'",
    { type: QueryTypes.SELECT },
  );
  const rounds = Math.max(1, Math.ceil((Number(activeCount.total) || 0) / MAX_PER_CYCLE));
  const freshnessSeconds = Math.max(180, Math.min(3600, INTERVAL * (rounds + 2)));
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
      ORDER BY CASE health_status WHEN 'down' THEN 0 WHEN 'suspect' THEN 1 WHEN 'unknown' THEN 2 WHEN 'healthy' THEN 3 ELSE 4 END,
        "partnerName" ASC NULLS LAST, name ASC, id ASC LIMIT :limit OFFSET :offset`,
    { replacements, type: QueryTypes.SELECT }),
    sequelize.query(`${base} SELECT health_status, count(*)::integer AS total FROM servers GROUP BY health_status`,
      { replacements, type: QueryTypes.SELECT }),
  ]);
  const summary = { total: 0, healthy: 0, suspect: 0, down: 0, unknown: 0, disabled: 0 };
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
