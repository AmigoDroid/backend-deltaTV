"use strict";
// Serviço white-label isolado do catálogo, das licenças e da cobrança legada do DeltaTV.
module.exports = {
  async up(q, S) {
    const uuid = () => ({ type: S.UUID, primaryKey: true, defaultValue: S.UUIDV4 });
    const partnerRef = { type: S.UUID, allowNull: false, references: { model: "partners", key: "id" }, onDelete: "CASCADE" };
    await q.sequelize.transaction(async (transaction) => {
      await q.createTable("white_label_apps", {
        id: uuid(), partner_id: partnerRef,
        app_key: { type: S.STRING(64), allowNull: false, unique: true },
        name: { type: S.STRING(120), allowNull: false },
        logo_url: { type: S.STRING(500) }, download_url: { type: S.STRING(500) },
        status: { type: S.STRING(20), allowNull: false, defaultValue: "draft" },
        plan_type: { type: S.STRING(20), allowNull: false, defaultValue: "limited" },
        activation_limit: { type: S.INTEGER },
        monthly_fee_cents: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        paid_through: { type: S.DATEONLY },
        notes: { type: S.TEXT },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await q.addIndex("white_label_apps", ["partner_id", "status"], { name: "ix_white_label_apps_partner_status", transaction });
      await q.sequelize.query("ALTER TABLE white_label_apps ADD CONSTRAINT ck_white_label_app_status CHECK (status IN ('draft','active','suspended','archived'))", { transaction });
      await q.sequelize.query("ALTER TABLE white_label_apps ADD CONSTRAINT ck_white_label_plan_type CHECK (plan_type IN ('limited','unlimited'))", { transaction });
      await q.sequelize.query("ALTER TABLE white_label_apps ADD CONSTRAINT ck_white_label_monthly_fee CHECK (monthly_fee_cents >= 0)", { transaction });
      await q.sequelize.query("ALTER TABLE white_label_apps ADD CONSTRAINT ck_white_label_limit CHECK ((plan_type = 'unlimited' AND activation_limit IS NULL) OR (plan_type = 'limited' AND activation_limit >= 1))", { transaction });
      await q.createTable("white_label_app_servers", {
        id: uuid(), app_id: { type: S.UUID, allowNull: false, references: { model: "white_label_apps", key: "id" }, onDelete: "CASCADE" },
        name: { type: S.STRING(120), allowNull: false }, base_url: { type: S.STRING(500), allowNull: false },
        status: { type: S.STRING(20), allowNull: false, defaultValue: "active" },
        priority: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await q.addIndex("white_label_app_servers", ["app_id", "status", "priority"], { name: "ix_white_label_servers_lookup", transaction });
      await q.addIndex("white_label_app_servers", ["app_id", "base_url"], { unique: true, name: "ux_white_label_server_url", transaction });
      await q.createTable("white_label_app_activations", {
        id: uuid(), app_id: { type: S.UUID, allowNull: false, references: { model: "white_label_apps", key: "id" }, onDelete: "CASCADE" },
        installation_hash: { type: S.CHAR(64), allowNull: false }, platform: { type: S.STRING(32), allowNull: false },
        status: { type: S.STRING(20), allowNull: false, defaultValue: "active" },
        activated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        last_seen_at: { type: S.DATE }, revoked_at: { type: S.DATE },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await q.addIndex("white_label_app_activations", ["app_id", "installation_hash"], { unique: true, name: "ux_white_label_installation", transaction });
      await q.addIndex("white_label_app_activations", ["app_id", "status"], { name: "ix_white_label_active_count", transaction });
      await q.createTable("white_label_app_payments", {
        id: uuid(), app_id: { type: S.UUID, allowNull: false, references: { model: "white_label_apps", key: "id" }, onDelete: "CASCADE" },
        reference: { type: S.STRING(120), allowNull: false }, months: { type: S.INTEGER, allowNull: false },
        amount_cents: { type: S.INTEGER, allowNull: false },
        previous_paid_through: { type: S.DATEONLY }, paid_through: { type: S.DATEONLY, allowNull: false },
        notes: { type: S.STRING(500) }, paid_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        created_by: { type: S.UUID, references: { model: "admin_users", key: "id" }, onDelete: "SET NULL" },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await q.addIndex("white_label_app_payments", ["app_id", "reference"], { unique: true, name: "ux_white_label_payment_ref", transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.dropTable("white_label_app_payments", { transaction });
      await q.dropTable("white_label_app_activations", { transaction });
      await q.dropTable("white_label_app_servers", { transaction });
      await q.dropTable("white_label_apps", { transaction });
    });
  },
};
