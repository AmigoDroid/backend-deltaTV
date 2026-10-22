"use strict";

const UP = `
ALTER TABLE activations
  ADD COLUMN playlist_name varchar(160),
  ADD COLUMN playlist_url_enc text;

CREATE TABLE device_pairing_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  token_enc text NOT NULL,
  registration_hash char(64) NOT NULL,
  registration_enc text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  registration_used_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_device_pairing_device ON device_pairing_tokens (device_id);
CREATE INDEX ix_device_pairing_expiry ON device_pairing_tokens (expires_at);
`;

const DOWN = `
DROP TABLE IF EXISTS device_pairing_tokens;
ALTER TABLE activations DROP COLUMN playlist_url_enc, DROP COLUMN playlist_name;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) =>
      queryInterface.sequelize.query(UP, { transaction }),
    );
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) =>
      queryInterface.sequelize.query(DOWN, { transaction }),
    );
  },
};
