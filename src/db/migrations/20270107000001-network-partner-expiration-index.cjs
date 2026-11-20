"use strict";
// Índice parcial para paginação e filtro expired no workspace, sem modificar dados.
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex("partners", ["owner_admin_id", "ends_at"], {
      name: "idx_partners_admin_expiration", where: { status: "active" },
    });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("partners", "idx_partners_admin_expiration");
  },
};
