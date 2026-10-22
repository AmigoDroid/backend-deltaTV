"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db (ver docs/04-verificacao.md).
const PK = `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`;

/*
 * Revendedor e propriedade comercial de licenças individuais.
 *  - partners.kind separa parceria de CONTEÚDO (fornece servidor/credenciais) de REVENDEDOR (compra/distribui licenças).
 *    Registros existentes ficam 'content' (comportamento atual preservado).
 *  - licenses.owner_partner_id = revendedor dono do estoque (NULL = licença da própria plataforma, como hoje).
 *  - license_events = histórico imutável de compra/atribuição/ativação/transferência/revogação.
 * A mensalidade do portal (partners/invoices) continua separada do estoque de licenças.
 */
const UP = `
ALTER TABLE partners
  ADD COLUMN kind varchar(10) NOT NULL DEFAULT 'content' CHECK (kind IN ('content','reseller','both'));

ALTER TABLE licenses
  ADD COLUMN owner_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
  ADD COLUMN platforms text[] NOT NULL DEFAULT ARRAY['roku','android','tizen','webos','web']::text[],
  ADD COLUMN assigned_at timestamptz,
  ADD CONSTRAINT ck_licenses_platforms CHECK (platforms <@ ARRAY['roku','android','tizen','webos','web']::text[] AND cardinality(platforms) > 0);
CREATE INDEX ix_licenses_owner ON licenses (owner_partner_id) WHERE owner_partner_id IS NOT NULL;

CREATE TABLE license_events (
  ${PK},
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE SET NULL,
  event varchar(16) NOT NULL CHECK (event IN ('purchased','assigned','activated','transferred','suspended','reactivated','revoked','released')),
  from_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  to_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  actor_type varchar(12) NOT NULL,
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_license_events_license ON license_events (license_id, created_at DESC);
CREATE INDEX ix_license_events_partner ON license_events (partner_id, created_at DESC);
`;

const DOWN = `
DROP TABLE IF EXISTS license_events;
DROP INDEX IF EXISTS ix_licenses_owner;
ALTER TABLE licenses
  DROP CONSTRAINT IF EXISTS ck_licenses_platforms,
  DROP COLUMN assigned_at, DROP COLUMN platforms, DROP COLUMN owner_partner_id;
ALTER TABLE partners DROP COLUMN kind;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
