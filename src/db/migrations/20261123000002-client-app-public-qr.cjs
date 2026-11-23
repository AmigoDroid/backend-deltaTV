"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn('client_apps', 'logo_url', { type: Sequelize.TEXT, allowNull: true }, { transaction });
      await queryInterface.addColumn('client_apps', 'theme', { type: Sequelize.JSONB, allowNull: true }, { transaction });
      await queryInterface.addColumn('device_pairing_tokens', 'qr_link_in_progress_at', { type: Sequelize.DATE, allowNull: true }, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.removeColumn('device_pairing_tokens', 'qr_link_in_progress_at', { transaction });
      await queryInterface.removeColumn('client_apps', 'theme', { transaction });
      await queryInterface.removeColumn('client_apps', 'logo_url', { transaction });
    });
  },
};
