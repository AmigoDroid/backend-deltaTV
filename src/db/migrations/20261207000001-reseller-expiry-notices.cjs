"use strict";
// Preferências globais de aviso por revenda; cadastro do cliente continua sendo a fonte da data.
const UP = `
CREATE TABLE reseller_expiry_notice_settings (
  partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  days_before smallint NOT NULL DEFAULT 3 CHECK (days_before BETWEEN 1 AND 30),
  message_mode varchar(12) NOT NULL DEFAULT 'service' CHECK (message_mode IN ('service','channels','custom')),
  custom_before varchar(180), custom_today varchar(180),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
module.exports = {
  async up(q) { await q.sequelize.query(UP); },
  async down(q) { await q.sequelize.query('DROP TABLE IF EXISTS reseller_expiry_notice_settings'); },
};
