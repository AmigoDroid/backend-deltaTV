"use strict";
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("activations", "web_auto_https", {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("activations", "web_auto_https");
  },
};
