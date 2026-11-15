"use strict";
/** Apenas Masters principais; autorização nunca é herdada por Submasters. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        CREATE TABLE IF NOT EXISTS reseller_master_issuance_permissions (
          partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE RESTRICT,
          enabled boolean NOT NULL DEFAULT false,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS reseller_master_issuance_requests (
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          idempotency_key uuid NOT NULL,
          months integer NOT NULL CHECK (months BETWEEN 1 AND 120),
          quantity integer NOT NULL CHECK (quantity > 0),
          balance_after integer NOT NULL CHECK (balance_after >= 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (partner_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS ix_reseller_master_issuance_requests_partner_created
          ON reseller_master_issuance_requests(partner_id, created_at DESC);
      `, { transaction });
    });
  },
  // Não apaga lançamentos de estoque nem histórico de emissão em rollback automático.
  async down() { throw new Error('Migração forward-only: revogue autorizações; não elimine extratos de emissão.'); },
};
