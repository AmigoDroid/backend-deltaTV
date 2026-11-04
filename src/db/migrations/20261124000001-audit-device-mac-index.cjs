"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addIndex("audit_logs", [Sequelize.literal("(metadata ->> 'mac')"), "created_at"], { name: "ix_audit_device_mac_created" });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("audit_logs", "ix_audit_device_mac_created");
  },
};
