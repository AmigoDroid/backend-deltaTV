'use strict';
/** Entrega entre Master e sua revenda direta, sem simular confirmação financeira. */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        CREATE TABLE IF NOT EXISTS reseller_master_license_deliveries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          buyer_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          idempotency_key uuid NOT NULL,
          transfer_id uuid NOT NULL UNIQUE,
          months int NOT NULL CHECK(months BETWEEN 1 AND 120),
          quantity int NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
          purpose varchar(24) NOT NULL CHECK(purpose IN ('external_payment','complimentary')),
          note varchar(200),
          actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT uq_master_license_delivery_key UNIQUE(seller_partner_id,idempotency_key),
          CONSTRAINT ck_master_license_delivery_different CHECK(seller_partner_id <> buyer_partner_id)
        );
        CREATE INDEX IF NOT EXISTS ix_master_license_deliveries_seller_created
          ON reseller_master_license_deliveries(seller_partner_id,created_at DESC);
      `,{transaction});
    });
  },
  async down() { throw new Error('Migração forward-only: preserve entregas de licenças e extratos históricos.'); },
};
