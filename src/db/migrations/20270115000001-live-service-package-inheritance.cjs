'use strict';

// Históricos de venda permanecem imutáveis. A cópia técnica de cada atribuição
// passa a acompanhar o catálogo; exceções individuais continuam explícitas.
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`ALTER TABLE partner_service_package_assignments
        ADD COLUMN live_snapshot jsonb`, { transaction });
      await q.sequelize.query(`ALTER TABLE partner_service_plans
        ADD COLUMN activation_limit_inherited boolean NOT NULL DEFAULT false`, { transaction });
      await q.sequelize.query(`UPDATE partner_service_package_assignments
        SET live_snapshot=package_snapshot`, { transaction });
      await q.sequelize.query(`UPDATE partner_service_plans ps
        SET activation_limit_inherited=true
        FROM service_plan_catalogs c, content_partner_terms ct
        WHERE ps.tier=c.key AND c.owner_admin_id IS NOT NULL
          AND ct.partner_id=ps.partner_id
          AND ((c.activation_limit IS NULL AND ct.mode='fixed_unlimited')
            OR (c.activation_limit IS NOT NULL AND ct.mode='fixed_limited'
                AND ct.activation_limit=c.activation_limit))`, { transaction });
      // Bloqueia a migração caso uma edição antiga tenha deixado uso acima
      // do limite atualmente publicado; jamais invalida TVs silenciosamente.
      const checks = [
        [`SELECT a.partner_id FROM partner_service_package_assignments a
          JOIN partner_service_plans ps ON ps.partner_id=a.partner_id
          JOIN partner_portal_sales_plans p ON p.code=a.package_code
          JOIN service_plan_catalogs c ON c.key=p.service_tier
          WHERE ps.tier=p.service_tier AND ps.max_apps_override=(a.package_snapshot->>'maxApps')::int
            AND (SELECT count(*) FROM partner_apps pa WHERE pa.partner_id=a.partner_id AND pa.status IN ('active','paused'))>c.max_apps
          LIMIT 1`, 'apps próprios'],
        [`SELECT a.partner_id FROM partner_service_package_assignments a
          JOIN partner_service_plans ps ON ps.partner_id=a.partner_id
          JOIN partner_portal_sales_plans p ON p.code=a.package_code
          JOIN partner_codes code ON code.partner_id=a.partner_id AND code.status='active'
          JOIN code_server_pools pool ON pool.code_id=code.id
          WHERE ps.tier=p.service_tier AND p.max_dns IS NOT NULL
            AND ((a.package_snapshot->>'maxDns' IS NULL AND ps.max_servers_override=0)
              OR ps.max_servers_override=(a.package_snapshot->>'maxDns')::int)
          GROUP BY a.partner_id,code.id,p.max_dns HAVING count(pool.id)>p.max_dns LIMIT 1`, 'DNS'],
        [`SELECT a.partner_id FROM partner_service_package_assignments a
          JOIN partner_service_plans ps ON ps.partner_id=a.partner_id
          JOIN partner_portal_sales_plans p ON p.code=a.package_code
          JOIN content_partner_terms ct ON ct.partner_id=a.partner_id
          WHERE ps.tier=p.service_tier AND p.activation_limit IS NOT NULL
            AND ((ct.mode='fixed_limited' AND ct.activation_limit=(a.package_snapshot->>'activationLimit')::int)
              OR (ct.mode='fixed_unlimited' AND a.package_snapshot->>'activationLimit' IS NULL))
            AND (SELECT count(*) FROM activations ac WHERE ac.partner_id=a.partner_id AND ac.status<>'revoked')>p.activation_limit
          LIMIT 1`, 'ativações'],
      ];
      for (const [sql, resource] of checks) {
        const [rows] = await q.sequelize.query(sql, { transaction });
        if (rows.length) throw new Error(`Plano existente com ${resource} acima da cota; ajuste esse contrato antes de migrar.`);
      }
      // Back-up pontual permite desfazer o backfill sem tocar nos contratos de venda.
      await q.sequelize.query(`CREATE TABLE service_package_inheritance_backup_20270115 AS
        SELECT ps.partner_id, ps.max_servers_override, ps.max_apps_override,
          ps.auto_failover_override, ps.auto_priority_override,
          ps.email_alerts_override, ps.detailed_history_override,
          p.revision AS package_revision, a.package_code
        FROM partner_service_plans ps
        JOIN partner_service_package_assignments a ON a.partner_id=ps.partner_id
        JOIN partner_portal_sales_plans p ON p.code=a.package_code
        WHERE ps.tier=a.package_snapshot->>'tier'`, { transaction });
      await q.sequelize.query(`CREATE UNIQUE INDEX service_package_inheritance_backup_20270115_pk
        ON service_package_inheritance_backup_20270115(partner_id)`, { transaction });
      // Só limpa campos iguais ao snapshot atribuído: valores diferentes são exceções.
      await q.sequelize.query(`UPDATE partner_service_plans ps SET
        max_servers_override=CASE WHEN
          (a.package_snapshot->>'maxDns' IS NULL AND ps.max_servers_override=0)
          OR (a.package_snapshot->>'maxDns' IS NOT NULL AND ps.max_servers_override=(a.package_snapshot->>'maxDns')::int)
          THEN NULL ELSE ps.max_servers_override END,
        max_apps_override=CASE WHEN a.package_snapshot ? 'maxApps'
          AND ps.max_apps_override=(a.package_snapshot->>'maxApps')::int
          THEN NULL ELSE ps.max_apps_override END,
        auto_failover_override=CASE WHEN ps.auto_failover_override::text=a.package_snapshot->>'autoFailover'
          THEN NULL ELSE ps.auto_failover_override END,
        auto_priority_override=CASE WHEN ps.auto_priority_override::text=a.package_snapshot->>'autoPriority'
          THEN NULL ELSE ps.auto_priority_override END,
        email_alerts_override=CASE WHEN ps.email_alerts_override::text=a.package_snapshot->>'emailAlerts'
          THEN NULL ELSE ps.email_alerts_override END,
        detailed_history_override=CASE WHEN ps.detailed_history_override::text=a.package_snapshot->>'detailedHistory'
          THEN NULL ELSE ps.detailed_history_override END
        FROM partner_service_package_assignments a
        WHERE a.partner_id=ps.partner_id AND ps.tier=a.package_snapshot->>'tier'`, { transaction });
      await q.sequelize.query(`UPDATE partner_service_plans ps
        SET activation_limit_inherited=true
        FROM partner_service_package_assignments a
        JOIN content_partner_terms ct ON ct.partner_id=a.partner_id
        WHERE ps.partner_id=a.partner_id AND ps.tier=a.package_snapshot->>'tier'
          AND ((ct.mode='fixed_limited' AND ct.activation_limit=(a.package_snapshot->>'activationLimit')::int)
            OR (ct.mode='fixed_unlimited' AND a.package_snapshot->>'activationLimit' IS NULL))`, { transaction });
      // O contrato técnico só acompanha o pacote se ainda tiver os mesmos
      // valores da atribuição anterior. Exceções independentes não são tocadas.
      await q.sequelize.query(`UPDATE content_partner_terms ct SET
        mode=CASE WHEN (ct.mode='fixed_limited' AND ct.activation_limit=(a.package_snapshot->>'activationLimit')::int)
                     OR (ct.mode='fixed_unlimited' AND a.package_snapshot->>'activationLimit' IS NULL)
          THEN CASE WHEN p.activation_limit IS NULL THEN 'fixed_unlimited' ELSE 'fixed_limited' END ELSE ct.mode END,
        activation_limit=CASE WHEN (ct.mode='fixed_limited' AND ct.activation_limit=(a.package_snapshot->>'activationLimit')::int)
                     OR (ct.mode='fixed_unlimited' AND a.package_snapshot->>'activationLimit' IS NULL)
          THEN p.activation_limit ELSE ct.activation_limit END,
        auto_priority=CASE WHEN ct.auto_priority::text=a.package_snapshot->>'autoPriority'
          THEN p.auto_priority ELSE ct.auto_priority END
        FROM partner_service_package_assignments a
        JOIN partner_portal_sales_plans p ON p.code=a.package_code
        JOIN partner_service_plans ps ON ps.partner_id=a.partner_id AND ps.tier=p.service_tier
        WHERE ct.partner_id=a.partner_id`, { transaction });
      await q.sequelize.query(`UPDATE partner_service_package_assignments a SET live_snapshot=jsonb_build_object(
        'code',p.code,'name',p.name,'revision',p.revision,'tier',p.service_tier,
        'maxDns',p.max_dns,'activationLimit',p.activation_limit,'maxApps',COALESCE(c.max_apps,0),
        'autoFailover',p.auto_failover,'autoPriority',p.auto_priority AND p.auto_failover,
        'emailAlerts',p.email_alerts,'detailedHistory',p.detailed_history)
        FROM partner_portal_sales_plans p LEFT JOIN service_plan_catalogs c ON c.key=p.service_tier
        WHERE a.package_code=p.code`, { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      const [changed] = await q.sequelize.query(`SELECT b.partner_id FROM service_package_inheritance_backup_20270115 b
        JOIN partner_portal_sales_plans p ON p.code=b.package_code
        WHERE p.revision<>b.package_revision LIMIT 1`, { transaction });
      if (changed.length) throw new Error('Rollback bloqueado: pacote alterado após a migração. Reavalie os contratos antes de desfazer.');
      // Novas atribuições voltam a usar cópias fixas no mecanismo anterior.
      await q.sequelize.query(`UPDATE partner_service_plans ps SET
        max_servers_override=COALESCE(ps.max_servers_override, CASE WHEN a.live_snapshot->>'maxDns' IS NULL THEN 0 ELSE (a.live_snapshot->>'maxDns')::int END),
        max_apps_override=COALESCE(ps.max_apps_override, (a.live_snapshot->>'maxApps')::int),
        auto_failover_override=COALESCE(ps.auto_failover_override,(a.live_snapshot->>'autoFailover')::boolean),
        auto_priority_override=COALESCE(ps.auto_priority_override,(a.live_snapshot->>'autoPriority')::boolean),
        email_alerts_override=COALESCE(ps.email_alerts_override,(a.live_snapshot->>'emailAlerts')::boolean),
        detailed_history_override=COALESCE(ps.detailed_history_override,(a.live_snapshot->>'detailedHistory')::boolean)
        FROM partner_service_package_assignments a
        WHERE a.partner_id=ps.partner_id AND ps.tier=a.live_snapshot->>'tier'
          AND NOT EXISTS (SELECT 1 FROM service_package_inheritance_backup_20270115 b WHERE b.partner_id=ps.partner_id)`, { transaction });
      await q.sequelize.query(`UPDATE partner_service_plans ps SET
        max_servers_override=COALESCE(ps.max_servers_override,b.max_servers_override),
        max_apps_override=COALESCE(ps.max_apps_override,b.max_apps_override),
        auto_failover_override=COALESCE(ps.auto_failover_override,b.auto_failover_override),
        auto_priority_override=COALESCE(ps.auto_priority_override,b.auto_priority_override),
        email_alerts_override=COALESCE(ps.email_alerts_override,b.email_alerts_override),
        detailed_history_override=COALESCE(ps.detailed_history_override,b.detailed_history_override)
        FROM service_package_inheritance_backup_20270115 b WHERE b.partner_id=ps.partner_id`, { transaction });
      await q.sequelize.query(`ALTER TABLE partner_service_package_assignments DROP COLUMN live_snapshot`, { transaction });
      await q.sequelize.query(`ALTER TABLE partner_service_plans DROP COLUMN activation_limit_inherited`, { transaction });
      await q.sequelize.query(`DROP TABLE service_package_inheritance_backup_20270115`, { transaction });
    });
  },
};
