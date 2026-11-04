"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn("partner_pre_registrations", "configured_at", { type: Sequelize.DATE, allowNull: true }, { transaction });
      // Aproveita configurações administrativas já salvas depois do cadastro pelo convite.
      await queryInterface.sequelize.query(`
        UPDATE partner_pre_registrations AS r SET configured_at = (
          SELECT min(a.created_at) FROM audit_logs a
          WHERE a.entity_type = 'partner' AND a.entity_id = r.completed_partner_id::text
            AND a.actor_type = 'admin' AND a.result = 'success'
            AND a.action IN ('partner.update', 'content.terms.update')
            AND a.created_at >= r.completed_at
        ) WHERE r.status = 'completed' AND r.configured_at IS NULL`, { transaction });
      await queryInterface.addIndex("partner_pre_registrations", ["configured_at", "status", "created_at"], {
        name: "ix_partner_pre_reg_configuration", transaction,
      });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeIndex("partner_pre_registrations", "ix_partner_pre_reg_configuration", { transaction });
      await queryInterface.removeColumn("partner_pre_registrations", "configured_at", { transaction });
    });
  },
};
