'use strict';
/** Finanças por Admin delegado. Nunca reutiliza carteira/estoque Pix da DeltaTV.
 * A escolha ativa é exclusiva por Admin, mas cobranças preservam seu provedor original.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      const query = sql => q.sequelize.query(sql, { transaction });
      await query(`CREATE TABLE admin_network_gateways (
        admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        provider varchar(20) NOT NULL CHECK(provider IN ('mercadopago','infinitepay')),
        credentials_enc text NOT NULL,
        webhook_secret_enc text,
        account_ref varchar(160) NOT NULL,
        credential_fingerprint char(64) NOT NULL,
        tested_fingerprint char(64),
        tested_at timestamptz,
        active boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(admin_user_id,provider),
        CHECK (NOT active OR (tested_fingerprint=credential_fingerprint AND tested_at IS NOT NULL))
      );
      CREATE UNIQUE INDEX ux_admin_network_single_active_gateway
        ON admin_network_gateways(admin_user_id) WHERE active;
      CREATE TABLE admin_network_charges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
        partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
        kind varchar(16) NOT NULL CHECK(kind IN ('renewal','upgrade')),
        plan_from varchar(32),
        plan_to varchar(32) NOT NULL,
        amount_cents bigint NOT NULL CHECK(amount_cents>0),
        status varchar(16) NOT NULL DEFAULT 'creating'
          CHECK(status IN ('creating','pending','paid','expired','cancelled','failed','review')),
        provider varchar(20) CHECK(provider IN ('mercadopago','infinitepay')),
        method varchar(16) NOT NULL CHECK(method IN ('automatic','manual')),
        provider_ref varchar(160),
        transaction_nsu varchar(160),
        payment_slug varchar(160),
        checkout_url text,
        pix_code_enc text,
        expires_at timestamptz NOT NULL,
        paid_at timestamptz,
        manual_reference varchar(160),
        cancellation_reason varchar(500),
        cancelled_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((method='manual' AND provider IS NULL) OR (method='automatic' AND provider IS NOT NULL)),
        CHECK(status <> 'paid' OR paid_at IS NOT NULL),
        CHECK (status <> 'paid' OR method <> 'manual' OR manual_reference IS NOT NULL)
      );
      ALTER TABLE admin_network_charges ADD CONSTRAINT fk_network_charge_gateway
        FOREIGN KEY (owner_admin_id,provider) REFERENCES admin_network_gateways(admin_user_id,provider)
        ON UPDATE RESTRICT ON DELETE RESTRICT;
      CREATE INDEX ix_network_charge_owner_created ON admin_network_charges(owner_admin_id,created_at DESC,id DESC);
      CREATE UNIQUE INDEX ux_network_charge_manual_reference ON admin_network_charges(owner_admin_id,manual_reference) WHERE manual_reference IS NOT NULL;
      CREATE INDEX ix_network_charge_pending_expiry ON admin_network_charges(expires_at) WHERE status='pending';
      CREATE INDEX ix_network_charge_partner_created ON admin_network_charges(partner_id,created_at DESC);
      CREATE INDEX ix_network_charge_status_created ON admin_network_charges(status,created_at DESC);
      CREATE UNIQUE INDEX ux_network_charge_provider_ref ON admin_network_charges(provider,provider_ref)
        WHERE provider IS NOT NULL AND provider_ref IS NOT NULL;
      CREATE UNIQUE INDEX ux_network_charge_partner_open ON admin_network_charges(partner_id)
        WHERE status IN ('creating','pending');
      CREATE OR REPLACE FUNCTION assert_network_charge_owner() RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS(SELECT 1 FROM partners p WHERE p.id=NEW.partner_id AND p.owner_admin_id=NEW.owner_admin_id) THEN
          RAISE EXCEPTION 'partner_owner_mismatch' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_network_charge_owner BEFORE INSERT OR UPDATE OF partner_id,owner_admin_id
        ON admin_network_charges FOR EACH ROW EXECUTE FUNCTION assert_network_charge_owner();
      CREATE OR REPLACE FUNCTION protect_network_charge_identity() RETURNS trigger AS $$
      BEGIN
        IF NEW.owner_admin_id IS DISTINCT FROM OLD.owner_admin_id
          OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
          OR NEW.provider IS DISTINCT FROM OLD.provider
          OR NEW.method IS DISTINCT FROM OLD.method
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.plan_from IS DISTINCT FROM OLD.plan_from
          OR NEW.plan_to IS DISTINCT FROM OLD.plan_to
          OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents THEN
          RAISE EXCEPTION 'immutable_network_charge_identity' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER trg_network_charge_identity BEFORE UPDATE ON admin_network_charges
        FOR EACH ROW EXECUTE FUNCTION protect_network_charge_identity();
      `);
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query('DROP TABLE IF EXISTS admin_network_charges; DROP FUNCTION IF EXISTS assert_network_charge_owner(); DROP FUNCTION IF EXISTS protect_network_charge_identity(); DROP TABLE IF EXISTS admin_network_gateways;', { transaction });
    });
  },
};
