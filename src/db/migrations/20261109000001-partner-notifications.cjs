"use strict";
module.exports = {
  async up(q, S) {
    await q.createTable("partner_notifications", {
      id: { type: S.UUID, primaryKey: true, defaultValue: S.UUIDV4 },
      partner_id: { type: S.UUID, allowNull: false, references: { model: "partners", key: "id" }, onDelete: "CASCADE" },
      sender_id: { type: S.UUID, allowNull: true, references: { model: "admin_users", key: "id" }, onDelete: "SET NULL" },
      title: { type: S.STRING(140), allowNull: false },
      message: { type: S.TEXT, allowNull: false },
      severity: { type: S.STRING(16), allowNull: false, defaultValue: "info" },
      read_at: { type: S.DATE, allowNull: true },
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.NOW },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: S.NOW }
    });
    await q.addIndex("partner_notifications", ["partner_id", "created_at"], { name: "partner_notifications_inbox_idx" });
    await q.addIndex("partner_notifications", ["partner_id", "read_at"], { name: "partner_notifications_unread_idx" });
  },
  async down(q) { await q.dropTable("partner_notifications"); }
};
