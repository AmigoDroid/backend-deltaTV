/** Dependências reais das três consultas /usage, /daily e /devices.
 * Não altera nem cria tabelas. Serve para diagnosticar um deploy parcial.
 */
export const USAGE_REQUIRED_COLUMNS = Object.freeze({
  partners: ['id', 'name'],
  partner_portal_sellers: ['partner_id', 'parent_partner_id'],
  partner_portal_access_contracts: ['customer_partner_id', 'seller_partner_id'],
  partner_portal_cost_settings: ['singleton_id', 'vps_monthly_cents', 'domain_annual_cents', 'other_monthly_cents', 'proxy_cost_per_gb_cents'],
  partner_portal_usage_hourly: ['bucket_at', 'partner_id', 'device_id', 'media_kind', 'transport', 'bytes_out', 'request_count', 'error_count'],
  partner_portal_usage_alert_settings: ['singleton_id', 'monthly_node_gb_budget', 'master_monthly_node_gb_budget', 'cpu_percent', 'memory_percent', 'storage_percent', 'retention_days'],
});

export const USAGE_MIGRATIONS = Object.freeze([
  '20261221000001-partner-portal-sales.cjs',
  '20261223000001-partner-portal-usage.cjs',
]);

export function summarizeUsageSchema(columns, appliedMigrations = [], { migrationsKnown = true, settingsRows = {} } = {}) {
  const existing = new Map();
  for (const row of columns) {
    if (!existing.has(row.table_name)) existing.set(row.table_name, new Set());
    existing.get(row.table_name).add(row.column_name);
  }
  const missingTables = [];
  const missingColumns = [];
  for (const [table, fields] of Object.entries(USAGE_REQUIRED_COLUMNS)) {
    if (!existing.has(table)) { missingTables.push(table); continue; }
    for (const field of fields) if (!existing.get(table).has(field)) missingColumns.push(`${table}.${field}`);
  }
  const pendingMigrations = migrationsKnown ? USAGE_MIGRATIONS.filter(name => !appliedMigrations.includes(name)) : [];
  const missingSettings = Object.entries(settingsRows).filter(([, present]) => present === false).map(([table]) => table);
  const ready = migrationsKnown && missingTables.length === 0 && missingColumns.length === 0 && missingSettings.length === 0 && pendingMigrations.length === 0;
  return { status: ready ? 'ready' : migrationsKnown ? 'migration_required' : 'migration_status_unknown', ready, missingTables, missingColumns, missingSettings,
    pendingMigrations, migrationsKnown, requiredMigration: USAGE_MIGRATIONS[1] };
}
