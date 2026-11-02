"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("admin_users", "last_activity_at", { type: Sequelize.DATE, allowNull: true });
    await queryInterface.addIndex("admin_users", ["partner_id", "role", "last_activity_at"], { name: "admin_users_partner_presence_idx" });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("admin_users", "admin_users_partner_presence_idx");
    await queryInterface.removeColumn("admin_users", "last_activity_at");
  },
};
