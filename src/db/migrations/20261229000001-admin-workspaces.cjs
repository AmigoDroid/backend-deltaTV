"use strict";
// Migração aditiva. Contas existentes permanecem na administração DeltaTV (owner_admin_id NULL).
// A DeltaTV cria novos administradores e eles só podem operar registros explicitamente próprios.
module.exports = {
  async up(q, Sequelize) {
    await q.sequelize.transaction(async transaction => {
      await q.addColumn("partners", "owner_admin_id", {
        type: Sequelize.UUID, allowNull: true,
        references: { model: "admin_users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      }, { transaction });
      await q.addColumn("service_plan_catalogs", "owner_admin_id", {
        type: Sequelize.UUID, allowNull: true,
        references: { model: "admin_users", key: "id" }, onUpdate: "CASCADE", onDelete: "RESTRICT",
      }, { transaction });
      await q.addColumn("admin_users", "delegated_permissions", {
        type: Sequelize.JSONB, allowNull: false, defaultValue: [],
      }, { transaction });
      await q.addColumn("admin_users", "network_limits", {
        type: Sequelize.JSONB, allowNull: false, defaultValue: {},
      }, { transaction });
      await q.addIndex("partners", ["owner_admin_id", "status"], { name: "idx_partners_admin_workspace", transaction });
      await q.addIndex("service_plan_catalogs", ["owner_admin_id", "active"], { name: "idx_service_plans_admin_workspace", transaction });
      await q.sequelize.query(`ALTER TABLE admin_users ADD CONSTRAINT admin_delegated_permissions_array CHECK (jsonb_typeof(delegated_permissions)='array')`, { transaction });
    });
  },
  async down() { throw new Error("A reversão removeria a propriedade das redes. Faça migração assistida antes de reverter."); },
};
