"use strict";

/** Convites de parceiro: independentes de Partner até o convidado concluir o cadastro. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable("partner_pre_registrations", {
        id: { type: Sequelize.UUID, primaryKey: true, allowNull: false, defaultValue: Sequelize.literal("gen_random_uuid()") },
        name: { type: Sequelize.STRING(160), allowNull: false },
        email: { type: Sequelize.STRING(200), allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: "draft" },
        token_hash: { type: Sequelize.CHAR(64), allowNull: true },
        expires_at: { type: Sequelize.DATE, allowNull: true },
        email_sent_at: { type: Sequelize.DATE, allowNull: true },
        completed_at: { type: Sequelize.DATE, allowNull: true },
        completed_partner_id: { type: Sequelize.UUID, allowNull: true },
        created_by: { type: Sequelize.UUID, allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("now()") },
        updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal("now()") },
      }, { transaction });
      await queryInterface.addIndex("partner_pre_registrations", ["email"], { unique: true, name: "uq_partner_pre_reg_email", transaction });
      await queryInterface.addIndex("partner_pre_registrations", ["token_hash"], { unique: true, name: "uq_partner_pre_reg_token", transaction });
      await queryInterface.addIndex("partner_pre_registrations", ["status", "created_at"], { name: "ix_partner_pre_reg_status", transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable("partner_pre_registrations");
  },
};
