/** Falha rápida antes de abrir HTTP: não servir Pix sobre esquema antigo. */
export async function verifyRequiredSchema(sequelize) {
  const qi = sequelize.getQueryInterface();
  const required = {
    device_remote_commands: ["id", "activation_id", "device_id", "status", "expires_at", "delivered_at", "executed_at", "payload", "result"],
    device_failover_requests: ["activation_id", "avoid_provider_id", "requested_at", "expires_at"],
    provider_quality_alerts: ["id", "provider_id", "severity", "resolved_at"],
    help_articles: ["id", "slug", "audience", "status", "steps", "body"],
    help_user_progress: ["admin_user_id", "article_id", "step_index", "completed_at"],
    help_user_states: ["admin_user_id", "welcome_seen_at"],
    white_label_apps: ["id", "partner_id", "app_key", "plan_type", "activation_limit", "monthly_fee_cents", "paid_through"],
    white_label_app_servers: ["app_id", "base_url", "status"],
    white_label_app_activations: ["app_id", "installation_hash", "status"],
    white_label_app_payments: ["app_id", "reference", "months", "paid_through"],
    admin_users: ["id", "password_reset_hash", "password_reset_expires_at", "password_reset_issued_at"],
    pix_refund_cases: ["id", "charge_id", "status", "amount_cents"],
    admin_user_profiles: ["admin_user_id", "phone", "avatar_data", "show_unread_banner", "show_notification_badge"],
    web_accesses: ["id", "status", "status_reason", "content_owner_partner_id", "source_partner_code_id"],
    partner_trash_snapshots: ["partner_id", "previous_status", "users", "codes", "providers", "web_accesses"],
  };
  for (const [table, columns] of Object.entries(required)) {
    let schema;
    try { schema = await qi.describeTable(table); }
    catch (cause) {
      throw new Error(`Banco não migrado: falta a tabela ${table}. Execute npm run db:migrate ANTES de iniciar a API.`, { cause });
    }
    const missing = columns.filter((column) => !Object.hasOwn(schema, column));
    if (missing.length)
      throw new Error(`Banco não migrado: ${table} sem ${missing.join(", ")}. Execute npm run db:migrate.`);
  }
  return true;
}
