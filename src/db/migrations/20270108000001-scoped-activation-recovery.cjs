"use strict";
// Apenas o vínculo revogado permanece recuperável; nunca armazenamos senhas em texto claro.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("activations", "recovery_credentials_enc", {
      type: Sequelize.TEXT, allowNull: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("activations", "recovery_credentials_enc");
  },
};
