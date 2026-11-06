"use strict";

// Só o SHA-256 do segredo é persistido. O e-mail recebe o token de uso único.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async (transaction) => {
      await q.addColumn("admin_users", "password_reset_hash", { type: S.CHAR(64), allowNull: true }, { transaction });
      await q.addColumn("admin_users", "password_reset_expires_at", { type: S.DATE, allowNull: true }, { transaction });
      await q.addColumn("admin_users", "password_reset_issued_at", { type: S.DATE, allowNull: true }, { transaction });
      await q.sequelize.query("CREATE UNIQUE INDEX admin_users_password_reset_hash_uidx ON admin_users (password_reset_hash) WHERE password_reset_hash IS NOT NULL", { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query("DROP INDEX IF EXISTS admin_users_password_reset_hash_uidx", { transaction });
      await q.removeColumn("admin_users", "password_reset_issued_at", { transaction });
      await q.removeColumn("admin_users", "password_reset_expires_at", { transaction });
      await q.removeColumn("admin_users", "password_reset_hash", { transaction });
    });
  },
};
