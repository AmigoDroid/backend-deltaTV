"use strict";
module.exports = {
  async up(q, S) {
    await q.createTable("login_history", {
      id: { type: S.UUID, primaryKey: true, defaultValue: S.UUIDV4 },
      admin_user_id: { type: S.UUID, allowNull: true, references: { model: "admin_users", key: "id" }, onDelete: "SET NULL" },
      user_email: { type: S.STRING(200), allowNull: true },
      role: { type: S.STRING(20) },
      partner_id: { type: S.UUID },
      outcome: { type: S.STRING(12), allowNull: false },
      reason: { type: S.STRING(60) },
      ip: { type: S.STRING(64) },
      isp: { type: S.STRING(160) },
      country: { type: S.STRING(90) },
      region: { type: S.STRING(90) },
      city: { type: S.STRING(90) },
      user_agent: { type: S.STRING(500) },
      browser: { type: S.STRING(90) },
      os: { type: S.STRING(90) },
      device: { type: S.STRING(90) },
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.NOW },
    });
    await q.addIndex("login_history", ["created_at"], { name: "login_history_created_idx" });
    await q.addIndex("login_history", ["admin_user_id", "created_at"], { name: "login_history_user_created_idx" });
    await q.addIndex("login_history", ["partner_id", "created_at"], { name: "login_history_partner_created_idx" });
  },
  async down(q) { await q.dropTable("login_history"); },
};
