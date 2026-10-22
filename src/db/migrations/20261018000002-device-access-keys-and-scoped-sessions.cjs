"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db (ver docs/04-verificacao.md).
const PK = `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
const TS = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;

const UP = `

-- Chave de 6 dígitos (só o HMAC é guardado) e sessão limitada ao dispositivo.
CREATE TABLE device_access_keys (
  ${PK},
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at timestamptz,
  invalidated_at timestamptz,
  requested_ip varchar(64),
  ${TS}
);
CREATE INDEX ix_device_access_keys_device ON device_access_keys (device_id, created_at DESC);
-- No máximo UMA chave viva por dispositivo. O serviço deve invalidar as expiradas antes de gerar outra (na mesma transação).
CREATE UNIQUE INDEX ux_device_access_keys_live ON device_access_keys (device_id) WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE device_scoped_sessions (
  ${PK},
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip varchar(64),
  user_agent varchar(300),
  ${TS}
);
CREATE INDEX ix_device_scoped_sessions_device ON device_scoped_sessions (device_id);

`;

const DOWN = `

DROP TABLE IF EXISTS device_scoped_sessions;
DROP TABLE IF EXISTS device_access_keys;

`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
