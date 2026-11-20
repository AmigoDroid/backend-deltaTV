'use strict';
/** Política de preços por rede, tetos globais e snapshot à prova de edição. */
module.exports={
 async up(q){await q.sequelize.transaction(async transaction=>{
  const exec=sql=>q.sequelize.query(sql,{transaction});
  await exec(`CREATE TABLE platform_billing_caps(
    id smallint PRIMARY KEY DEFAULT 1 CHECK(id=1),
    late_fee_pct numeric(5,2) NOT NULL DEFAULT 2 CHECK(late_fee_pct BETWEEN 0 AND 100),
    interest_monthly_pct numeric(5,2) NOT NULL DEFAULT 1 CHECK(interest_monthly_pct BETWEEN 0 AND 100),
    conditions_text text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO platform_billing_caps(id) VALUES(1);
  CREATE TABLE admin_billing_settings(
    admin_user_id uuid PRIMARY KEY REFERENCES admin_users(id) ON DELETE RESTRICT,
    late_fee_enabled boolean NOT NULL DEFAULT true,
    late_fee_pct numeric(5,2) NOT NULL DEFAULT 2,
    interest_monthly_pct numeric(5,2) NOT NULL DEFAULT 1,
    tolerance_days smallint NOT NULL DEFAULT 0 CHECK(tolerance_days BETWEEN 0 AND 10),
    early_discount_enabled boolean NOT NULL DEFAULT false,
    early_discount_type varchar(16) NOT NULL DEFAULT 'percent' CHECK(early_discount_type IN ('percent','fixed_cents')),
    early_discount_value numeric(12,2) NOT NULL DEFAULT 0 CHECK(early_discount_value>=0),
    early_min_days_before integer NOT NULL DEFAULT 0 CHECK(early_min_days_before>=0),
    early_starts_at timestamptz,
    early_ends_at timestamptz,
    early_plan_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    default_discount_days integer NOT NULL DEFAULT 0 CHECK(default_discount_days>=0),
    min_charge_cents bigint NOT NULL DEFAULT 100 CHECK(min_charge_cents>=1),
    short_cycle_days integer NOT NULL DEFAULT 0 CHECK(short_cycle_days>=0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK(early_ends_at IS NULL OR early_starts_at IS NULL OR early_ends_at>=early_starts_at)
  );
  ALTER TABLE admin_network_charges ADD COLUMN breakdown jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE admin_network_charges ADD COLUMN paid_amount_cents bigint;
  ALTER TABLE admin_network_charges ADD COLUMN review_reason varchar(100);
  ALTER TABLE admin_network_charges DROP CONSTRAINT IF EXISTS admin_network_charges_status_check;
  ALTER TABLE admin_network_charges ADD CONSTRAINT admin_network_charges_status_check
    CHECK(status IN ('creating','pending','paid','expired','cancelled','failed','review','needs_review'));
  CREATE OR REPLACE FUNCTION protect_network_charge_breakdown() RETURNS trigger AS $$
  BEGIN
    IF NEW.breakdown IS DISTINCT FROM OLD.breakdown THEN
      RAISE EXCEPTION 'immutable_charge_breakdown' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END; $$ LANGUAGE plpgsql;
  CREATE TRIGGER trg_network_charge_breakdown BEFORE UPDATE ON admin_network_charges
    FOR EACH ROW EXECUTE FUNCTION protect_network_charge_breakdown();
  CREATE INDEX ix_network_charge_review ON admin_network_charges(owner_admin_id,created_at DESC)
    WHERE status='needs_review';`);
 });},
 async down(q){await q.sequelize.transaction(async transaction=>{
  await q.sequelize.query(`DROP INDEX IF EXISTS ix_network_charge_review;
  DROP TRIGGER IF EXISTS trg_network_charge_breakdown ON admin_network_charges;
  DROP FUNCTION IF EXISTS protect_network_charge_breakdown();
  UPDATE admin_network_charges SET status='review' WHERE status='needs_review';
  ALTER TABLE admin_network_charges DROP CONSTRAINT IF EXISTS admin_network_charges_status_check;
  ALTER TABLE admin_network_charges ADD CONSTRAINT admin_network_charges_status_check
    CHECK(status IN ('creating','pending','paid','expired','cancelled','failed','review'));
  ALTER TABLE admin_network_charges DROP COLUMN review_reason;
  ALTER TABLE admin_network_charges DROP COLUMN paid_amount_cents;
  ALTER TABLE admin_network_charges DROP COLUMN breakdown;
  DROP TABLE IF EXISTS admin_billing_settings;
  DROP TABLE IF EXISTS platform_billing_caps;`,{transaction});
 });}
};
