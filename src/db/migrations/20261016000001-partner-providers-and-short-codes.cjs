"use strict";
/**
 * - partner_providers: URLs (servidores) do provedor de cada parceria.
 * - partner_codes: passa a usar CÓDIGO CURTO em texto (4–12 [A-Z0-9]), único em toda a plataforma.
 *   Os códigos longos antigos eram guardados só como hash e não podem ser recuperados:
 *   as linhas existentes são mantidas, REVOGADAS e recebem um código reservado "OLD…".
 * - activations: guarda o provedor escolhido e as credenciais do cliente (cifradas).
 */
const TS = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;

const UP = `
CREATE TABLE partner_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  base_url varchar(500) NOT NULL,
  playlist_template varchar(500) NOT NULL DEFAULT '/get.php?username={username}&password={password}&type=m3u_plus&output=m3u8',
  delivery_mode varchar(20) NOT NULL DEFAULT 'redirect' CHECK (delivery_mode IN ('redirect','proxy')),
  priority int NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  ${TS}
);
CREATE INDEX ix_partner_providers_partner ON partner_providers (partner_id);
CREATE UNIQUE INDEX ux_partner_providers_url ON partner_providers (partner_id, lower(base_url));

ALTER TABLE partner_codes ADD COLUMN code varchar(12);
UPDATE partner_codes
   SET code = upper('OLD' || substr(replace(id::text, '-', ''), 1, 9)), status = 'revoked';
ALTER TABLE partner_codes ALTER COLUMN code SET NOT NULL;
ALTER TABLE partner_codes ADD CONSTRAINT ck_partner_codes_format CHECK (code ~ '^[A-Z0-9]{4,12}$');
-- Unicidade global (inclui revogados): um código nunca é reaproveitado por outra parceria.
CREATE UNIQUE INDEX ux_partner_codes_code ON partner_codes (code);
ALTER TABLE partner_codes DROP COLUMN code_hash, DROP COLUMN code_last4;

ALTER TABLE activations
  ADD COLUMN provider_id uuid REFERENCES partner_providers(id) ON DELETE SET NULL,
  ADD COLUMN credentials_enc text;
CREATE INDEX ix_activations_provider ON activations (provider_id);
`;

const DOWN = `
ALTER TABLE activations DROP COLUMN credentials_enc, DROP COLUMN provider_id;
ALTER TABLE partner_codes ADD COLUMN code_hash char(64), ADD COLUMN code_last4 varchar(4);
UPDATE partner_codes SET code_hash = encode(sha256(code::bytea), 'hex'), code_last4 = right(code, 4);
ALTER TABLE partner_codes ALTER COLUMN code_hash SET NOT NULL, ALTER COLUMN code_last4 SET NOT NULL;
ALTER TABLE partner_codes ADD CONSTRAINT partner_codes_code_hash_key UNIQUE (code_hash);
DROP INDEX IF EXISTS ux_partner_codes_code;
ALTER TABLE partner_codes DROP CONSTRAINT IF EXISTS ck_partner_codes_format;
ALTER TABLE partner_codes DROP COLUMN code;
DROP TABLE IF EXISTS partner_providers;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
