'use strict';

module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      const run = sql => q.sequelize.query(sql, {transaction});
      await run('LOCK TABLE service_plan_catalogs, partner_portal_sales_plans IN SHARE ROW EXCLUSIVE MODE');
      // Uma linha com code=key pode ser o adaptador de convites antigos. Dois
      // códigos comerciais diferentes apontando ao mesmo tier exigem revisão.
      const [conflicts] = await run(`SELECT c.key, array_agg(p.code ORDER BY p.code) AS codes
        FROM service_plan_catalogs c JOIN partner_portal_sales_plans p
          ON p.service_tier=c.key OR p.code=c.key
        WHERE c.owner_admin_id IS NULL AND c.deleted_at IS NULL GROUP BY c.key
        HAVING count(*) FILTER (WHERE p.service_tier=c.key AND p.code<>c.key)>1
          OR bool_or(p.code=c.key AND p.service_tier IS DISTINCT FROM c.key)`);
      if (conflicts.length) throw new Error('Códigos de pacote ambíguos: '+JSON.stringify(conflicts));
      await run(`ALTER TABLE partner_portal_sales_plans DROP CONSTRAINT partner_portal_sales_plans_wholesale_cents_check,
        ADD CHECK (wholesale_cents >= 0), ADD COLUMN catalog_package boolean NOT NULL DEFAULT false`);
      // Nenhuma referência histórica troca de chave. O alias continua válido
      // para leitura de contratos; apenas um código aceita novas atribuições.
      await run(`UPDATE partner_portal_sales_plans p SET catalog_package=true
        FROM service_plan_catalogs c WHERE p.service_tier=c.key AND c.owner_admin_id IS NULL AND c.deleted_at IS NULL
        AND (p.code<>c.key OR NOT EXISTS (SELECT 1 FROM partner_portal_sales_plans other
          WHERE other.service_tier=c.key AND other.code<>c.key))`);
      await run(`INSERT INTO partner_portal_sales_plans(code,name,wholesale_cents,min_resale_cents,active,
        service_tier,max_dns,activation_limit,auto_failover,auto_priority,email_alerts,detailed_history,catalog_package)
        SELECT key,name,COALESCE(monthly_price_cents,0),COALESCE(monthly_price_cents,0),active,
          key,max_servers,activation_limit,auto_failover,auto_priority,email_alerts,detailed_history,true
        FROM service_plan_catalogs c WHERE owner_admin_id IS NULL AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM partner_portal_sales_plans p WHERE p.service_tier=c.key AND p.catalog_package)`);
      await run(`UPDATE partner_portal_sales_plans p SET
        wholesale_cents=COALESCE(c.monthly_price_cents,p.wholesale_cents),
        min_resale_cents=CASE WHEN p.wholesale_cents=1 AND p.min_resale_cents=1
          THEN COALESCE(c.monthly_price_cents,p.min_resale_cents)
          ELSE greatest(p.min_resale_cents,COALESCE(c.monthly_price_cents,0)) END,
        activation_limit=c.activation_limit
        FROM service_plan_catalogs c WHERE p.catalog_package AND p.service_tier=c.key AND p.code=c.key`);
      // Convites anteriores assinam os limites técnicos. Uma divergência exige
      // conciliação quando já há um link vigente, antes de mudar a oferta.
      const [pending]=await run(`SELECT DISTINCT p.code,c.key FROM partner_portal_sales_plans p
        JOIN service_plan_catalogs c ON c.key=p.service_tier
        JOIN admin_network_invitations i ON i.plan_key=c.key
        WHERE p.catalog_package AND p.activation_limit IS DISTINCT FROM c.activation_limit
          AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.deleted_at IS NULL AND i.expires_at>now()`);
      if(pending.length)throw new Error('Limites divergentes em pacotes com convites vigentes: '+JSON.stringify(pending));
      await run(`UPDATE service_plan_catalogs c SET activation_limit=p.activation_limit
        FROM partner_portal_sales_plans p WHERE p.catalog_package AND p.service_tier=c.key
          AND c.activation_limit IS DISTINCT FROM p.activation_limit`);
      await run('CREATE UNIQUE INDEX service_package_global_tier ON partner_portal_sales_plans(service_tier) WHERE catalog_package');
    });
  },
  async down() { throw new Error('Restaure o backup anterior para desfazer a conversão sem perder novos pacotes gratuitos.'); }
};
