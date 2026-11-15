/** Falha rápida antes de abrir HTTP: não servir Pix sobre esquema antigo. */
export async function verifyRequiredSchema(sequelize) {
  const qi = sequelize.getQueryInterface();
  const required = {
    licenses:["max_sessions_per_activation"],
    permission_roles:["id","base_role","permissions"],
    impersonation_grants:["id","actor_id","target_id","session_id","expires_at","revoked_at"],
    tv_message_campaigns:["id","sender_id","partner_id","payload_hash"],
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
    admin_users: ["permission_role_id", "deleted_at", "id", "password_reset_hash", "password_reset_expires_at", "password_reset_issued_at"],
    pix_refund_cases: ["id", "charge_id", "status", "amount_cents"],
    admin_user_profiles: ["admin_user_id", "phone", "avatar_data", "show_unread_banner", "show_notification_badge"],
    web_accesses: ["id", "status", "status_reason", "content_owner_partner_id", "source_partner_code_id"],
    partner_trash_snapshots: ["partner_id", "previous_status", "users", "codes", "providers", "web_accesses"],
    partner_portal_sellers: ["partner_id","parent_partner_id","active","can_sell"],
    partner_portal_stock: ["seller_partner_id","plan_code","available_months"],
    partner_portal_access_contracts: ["customer_partner_id","seller_partner_id","expires_at"],
    partner_portal_usage_hourly: ["bucket_at","partner_id","device_id","transport","bytes_out","request_count"],
    partner_portal_usage_flushes: ["batch_id"],
    partner_portal_usage_alert_settings: ["singleton_id","monthly_node_gb_budget","cpu_percent"],
    partner_portal_sales_invitations: ["id","seller_partner_id","token_hash","status","expires_at","months","accepted_partner_id"],
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
  const [auditing]=await sequelize.query("SELECT to_regprocedure('deltatv_row_audit()') AS fn");
  if(!auditing[0]?.fn)throw new Error('Banco não migrado: falta auditoria transacional. Execute npm run db:migrate.');
  return true;
}
