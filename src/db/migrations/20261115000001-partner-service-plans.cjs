"use strict";
// A migração não altera contratos, pools ou ativações anteriores.
module.exports = {
  async up(q,S) {
    await q.createTable("partner_service_plans",{
      partner_id:{type:S.UUID,primaryKey:true,allowNull:false,references:{model:"partners",key:"id"},onDelete:"CASCADE"},
      tier:{type:S.STRING(32),allowNull:false},
      max_servers_override:{type:S.INTEGER,allowNull:true},
      auto_failover_override:{type:S.BOOLEAN,allowNull:true},
      auto_priority_override:{type:S.BOOLEAN,allowNull:true},
      email_alerts_override:{type:S.BOOLEAN,allowNull:true},
      detailed_history_override:{type:S.BOOLEAN,allowNull:true},
      created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
      updated_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
    });
    await q.sequelize.query(`ALTER TABLE partner_service_plans
      ADD CONSTRAINT chk_partner_service_tier CHECK (tier IN ('reseller_basic','partner_professional','partner_premium'));
      ALTER TABLE partner_service_plans
      ADD CONSTRAINT chk_partner_service_servers CHECK (max_servers_override IS NULL OR max_servers_override BETWEEN 1 AND 8);`);
    // Contas existentes de conteúdo mantêm os oito servidores e recursos atuais;
    // revendas continuam sem gerenciamento de pools múltiplos.
    await q.sequelize.query(`INSERT INTO partner_service_plans (partner_id, tier, created_at, updated_at)
       SELECT id, CASE WHEN kind='reseller' THEN 'reseller_basic' ELSE 'partner_premium' END, NOW(), NOW() FROM partners
       ON CONFLICT (partner_id) DO NOTHING`);
  },
  async down(q) { await q.dropTable("partner_service_plans"); }
};
