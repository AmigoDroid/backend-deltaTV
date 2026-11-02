"use strict";
// Remove o antigo teto absoluto de 8 URLs. NULL no catálogo = ilimitadas;
// exceção 0 no contrato individual = ilimitadas; NULL nessa exceção = herdar.
// Mantém os planos e contratos existentes intactos.
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (t) => {
      await q.sequelize.query(`
        ALTER TABLE service_plan_catalogs
          DROP CONSTRAINT IF EXISTS service_plan_catalog_servers_check;
        ALTER TABLE service_plan_catalogs ALTER COLUMN max_servers DROP NOT NULL;
        ALTER TABLE service_plan_catalogs
          ADD CONSTRAINT service_plan_catalog_servers_check
          CHECK (max_servers IS NULL OR max_servers >= 1);
        ALTER TABLE partner_service_plans
          DROP CONSTRAINT IF EXISTS chk_partner_service_servers;
        ALTER TABLE partner_service_plans
          ADD CONSTRAINT chk_partner_service_servers
          CHECK (max_servers_override IS NULL OR max_servers_override >= 0);
      `, { transaction:t });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (t) => {
      const [catalog] = await q.sequelize.query(`SELECT count(*)::int AS n FROM service_plan_catalogs
        WHERE max_servers IS NULL OR max_servers > 8`,{transaction:t});
      const [overrides] = await q.sequelize.query(`SELECT count(*)::int AS n FROM partner_service_plans
        WHERE max_servers_override = 0 OR max_servers_override > 8`,{transaction:t});
      if (Number(catalog[0]?.n) || Number(overrides[0]?.n)) {
        throw new Error("Há planos ilimitados ou com mais de 8 URLs: ajuste-os antes de reverter esta migration.");
      }
      await q.sequelize.query(`
        ALTER TABLE service_plan_catalogs DROP CONSTRAINT IF EXISTS service_plan_catalog_servers_check;
        ALTER TABLE service_plan_catalogs ALTER COLUMN max_servers SET NOT NULL;
        ALTER TABLE service_plan_catalogs ADD CONSTRAINT service_plan_catalog_servers_check
          CHECK (max_servers BETWEEN 1 AND 8);
        ALTER TABLE partner_service_plans DROP CONSTRAINT IF EXISTS chk_partner_service_servers;
        ALTER TABLE partner_service_plans ADD CONSTRAINT chk_partner_service_servers
          CHECK (max_servers_override IS NULL OR max_servers_override BETWEEN 1 AND 8);
      `,{transaction:t});
    });
  },
};
