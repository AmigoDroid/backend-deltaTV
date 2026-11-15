"use strict";
/** Direct device activation requests, idempotent for authorized Masters and Superadmins. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS license_direct_device_requests (
        issuer_type VARCHAR(10) NOT NULL CHECK (issuer_type IN ('master','admin')),
        issuer_id UUID NOT NULL,
        idempotency_key UUID NOT NULL,
        mac VARCHAR(17) NOT NULL,
        months INTEGER NOT NULL CHECK (months BETWEEN 1 AND 120),
        result JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (issuer_type, issuer_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS license_direct_device_requests_created_idx
        ON license_direct_device_requests(created_at);
    `);
  },
  // Não excluir histórico de emissão automaticamente; rollback exige decisão administrativa.
  async down() { throw new Error("Migração forward-only: preserve o histórico de emissão direta."); },
};
