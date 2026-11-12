"use strict";
// Compatível com registros existentes: todos começam como "uma vez ao dia".
module.exports = {
  async up(q) {
    await q.sequelize.query(`ALTER TABLE reseller_expiry_notice_settings
      ADD COLUMN IF NOT EXISTS delivery_mode varchar(16) NOT NULL DEFAULT 'daily'
      CHECK (delivery_mode IN ('daily', 'every_open'))`);
  },
  async down(q) {
    await q.sequelize.query(`ALTER TABLE reseller_expiry_notice_settings DROP COLUMN IF EXISTS delivery_mode`);
  },
};
