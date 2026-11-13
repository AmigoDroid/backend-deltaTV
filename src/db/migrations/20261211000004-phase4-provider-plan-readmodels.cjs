"use strict";
/** Etapa 4: unifica leitura operacional sem criar outra tabela de URLs,
 * sem copiar credenciais e sem reimplementar prioridade do modo proxy/redirect.
 * Os modos efetivos continuam resolvidos em mirror/mode.js e os planos
 * no service-plans/plan.service.js.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`CREATE OR REPLACE VIEW v_delta_provider_operations AS
      SELECT pp.id AS provider_id, pp.partner_id, pp.name, pp.status AS configured_status,
             pp.delivery_mode AS configured_delivery_mode, pp.priority,
             h.state AS probe_state, h.latency_ms, h.last_checked_at, h.last_good_at,
             h.successes, h.failures
      FROM partner_providers pp LEFT JOIN provider_health h ON h.provider_id=pp.id`);
    await q.sequelize.query(`CREATE OR REPLACE VIEW v_delta_partner_contract_inventory AS
      SELECT p.id AS partner_id, p.kind, p.status AS partner_status,
             ps.tier, sp.name AS service_plan_name, sp.active AS service_plan_active,
             ps.max_servers_override, ps.auto_failover_override, ps.auto_priority_override,
             ps.email_alerts_override, ps.detailed_history_override,
             ct.mode AS contract_mode, ct.license_policy AS contract_license_policy,
             ct.auto_priority AS legacy_contract_priority
      FROM partners p
      LEFT JOIN partner_service_plans ps ON ps.partner_id=p.id
      LEFT JOIN service_plan_catalogs sp ON sp.key=ps.tier
      LEFT JOIN content_partner_terms ct ON ct.partner_id=p.id`);
  },
  async down(q) {
    await q.sequelize.query('DROP VIEW IF EXISTS v_delta_partner_contract_inventory');
    await q.sequelize.query('DROP VIEW IF EXISTS v_delta_provider_operations');
  },
};
