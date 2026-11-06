"use strict";

// Preferências e avatar separados de admin_users: não carrega imagem em autenticação ou sessão.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.createTable("admin_user_profiles", {
        admin_user_id: { type: S.UUID, primaryKey: true, allowNull: false, references: { model: "admin_users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
        phone: { type: S.STRING(40), allowNull: true },
        avatar_data: { type: S.TEXT, allowNull: true },
        show_unread_banner: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
        show_notification_badge: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      await q.dropTable("admin_user_profiles", { transaction });
    });
  },
};
