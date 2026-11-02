"use strict";
// Catálogo editável: mantém chaves existentes para não alterar contratos.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async (t) => {
      await q.createTable("service_plan_catalogs", {
        key: { type: S.STRING(32), primaryKey: true, allowNull: false },
        name: { type: S.STRING(120), allowNull: false },
        description: { type: S.STRING(500), allowNull: false, defaultValue: "" },
        audience: { type: S.STRING(16), allowNull: false },
        monthly_price_cents: { type: S.INTEGER, allowNull: true },
        max_servers: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
        auto_failover: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        auto_priority: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        email_alerts: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        detailed_history: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
        system: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
        sort_order: { type: S.INTEGER, allowNull: false, defaultValue: 100 },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.fn("NOW") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.fn("NOW") },
      }, { transaction: t });
      await q.sequelize.query(`ALTER TABLE service_plan_catalogs
        ADD CONSTRAINT service_plan_catalog_key_check CHECK (key ~ '^[a-z][a-z0-9_]{2,31}$'),
        ADD CONSTRAINT service_plan_catalog_audience_check CHECK (audience IN ('reseller','content','both')),
        ADD CONSTRAINT service_plan_catalog_price_check CHECK (monthly_price_cents IS NULL OR monthly_price_cents BETWEEN 0 AND 100000000),
        ADD CONSTRAINT service_plan_catalog_servers_check CHECK (max_servers BETWEEN 1 AND 8);`, { transaction:t });
      await q.sequelize.query(`INSERT INTO service_plan_catalogs
        (key,name,description,audience,max_servers,auto_failover,auto_priority,email_alerts,detailed_history,system,sort_order)
        VALUES
        ('reseller_basic','Revenda · Básico','Monitoramento básico e um servidor por código','reseller',1,false,false,false,false,true,10),
        ('partner_professional','Parceiro · Profissional','Failover e até quatro URLs por código','content',4,true,false,true,false,true,20),
        ('partner_premium','Parceiro · Premium','Prioridade automática e histórico detalhado','content',8,true,true,true,true,true,30)
        ON CONFLICT (key) DO NOTHING`, { transaction:t });
      await q.sequelize.query(`ALTER TABLE partner_service_plans DROP CONSTRAINT IF EXISTS chk_partner_service_tier`, { transaction:t });
      await q.sequelize.query(`ALTER TABLE partner_service_plans ADD CONSTRAINT fk_partner_service_plan_catalog
        FOREIGN KEY (tier) REFERENCES service_plan_catalogs(key) ON DELETE RESTRICT ON UPDATE RESTRICT`, { transaction:t });
      await q.addIndex("service_plan_catalogs", ["active","audience","sort_order"], { name:"idx_service_plan_catalog_list", transaction:t });
      await q.addIndex("partner_service_plans", ["tier"], { name:"idx_partner_service_plans_tier", transaction:t });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (t) => {
      const [assigned] = await q.sequelize.query(`SELECT count(*)::integer AS n FROM partner_service_plans WHERE tier NOT IN
        ('reseller_basic','partner_professional','partner_premium')`, { transaction:t });
      if (Number(assigned[0]?.n || 0) > 0) throw new Error("Não é seguro desfazer: existem parceiros vinculados a planos personalizados.");
      await q.removeIndex("partner_service_plans","idx_partner_service_plans_tier",{transaction:t});
      await q.sequelize.query(`ALTER TABLE partner_service_plans DROP CONSTRAINT IF EXISTS fk_partner_service_plan_catalog`, { transaction:t });
      await q.sequelize.query(`ALTER TABLE partner_service_plans ADD CONSTRAINT chk_partner_service_tier
        CHECK (tier IN ('reseller_basic','partner_professional','partner_premium'))`, { transaction:t });
      await q.dropTable("service_plan_catalogs", { transaction:t });
    });
  }
};
