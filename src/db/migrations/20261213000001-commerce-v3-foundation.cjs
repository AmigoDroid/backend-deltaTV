"use strict";
/** DeltaTV 3.0: aditivo. Nenhuma migração legada é modificada e não faz backfill automático de pessoas por MAC. */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        CREATE TABLE commerce_customers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          name varchar(160) NOT NULL CHECK(length(btrim(name)) >= 2),
          email varchar(200), phone varchar(40), notes varchar(500),
          legacy_reseller_client_id uuid UNIQUE REFERENCES reseller_clients(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(partner_id,id)
        );
        CREATE INDEX idx_commerce_customers_scope ON commerce_customers(partner_id,created_at DESC);
        CREATE INDEX idx_commerce_customers_name ON commerce_customers(partner_id,lower(name));

        CREATE TABLE commerce_plans (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          owner_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
          kind varchar(12) NOT NULL CHECK(kind IN ('customer','master')),
          name varchar(120) NOT NULL,
          price_cents bigint NOT NULL DEFAULT 0 CHECK(price_cents >= 0),
          period_months int NOT NULL DEFAULT 1 CHECK(period_months BETWEEN 1 AND 120),
          billing_mode varchar(12) NOT NULL DEFAULT 'prepaid' CHECK(billing_mode IN ('prepaid','postpaid','hybrid')),
          included_slots integer CHECK(included_slots IS NULL OR included_slots >= 0),
          allow_extra boolean NOT NULL DEFAULT false,
          allow_resell boolean NOT NULL DEFAULT false,
          overage_cents bigint CHECK(overage_cents IS NULL OR overage_cents >= 0),
          grace_days integer NOT NULL DEFAULT 5 CHECK(grace_days BETWEEN 0 AND 365),
          active boolean NOT NULL DEFAULT true,
          version integer NOT NULL DEFAULT 1,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK(kind = 'master' OR owner_partner_id IS NOT NULL),
          CHECK(kind = 'customer' OR owner_partner_id IS NULL)
        );
        CREATE INDEX idx_commerce_plans_kind ON commerce_plans(kind,owner_partner_id,active);

        CREATE TABLE commerce_subscriptions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          customer_id uuid,
          subject_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
          plan_id uuid NOT NULL REFERENCES commerce_plans(id) ON DELETE RESTRICT,
          kind varchar(12) NOT NULL CHECK(kind IN ('customer','master')),
          state varchar(16) NOT NULL DEFAULT 'draft'
            CHECK(state IN ('draft','active','past_due','restricted','suspended','cancelled')),
          billing_mode varchar(12) NOT NULL CHECK(billing_mode IN ('prepaid','postpaid','hybrid')),
          slots_snapshot integer CHECK(slots_snapshot IS NULL OR slots_snapshot >= 0),
          price_cents_snapshot bigint NOT NULL CHECK(price_cents_snapshot >= 0),
          period_months_snapshot int NOT NULL CHECK(period_months_snapshot BETWEEN 1 AND 120),
          grace_days_snapshot integer NOT NULL CHECK(grace_days_snapshot BETWEEN 0 AND 365),
          starts_at timestamptz, paid_through timestamptz, next_due_at timestamptz,
          notes varchar(400),
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          FOREIGN KEY(partner_id,customer_id) REFERENCES commerce_customers(partner_id,id) ON DELETE RESTRICT,
          CHECK((kind='customer' AND customer_id IS NOT NULL AND subject_partner_id IS NULL)
            OR (kind='master' AND customer_id IS NULL AND subject_partner_id IS NOT NULL)),
          CHECK(starts_at IS NULL OR paid_through IS NULL OR paid_through > starts_at)
        );
        CREATE INDEX idx_commerce_sub_scope ON commerce_subscriptions(partner_id,created_at DESC);
        CREATE UNIQUE INDEX ux_commerce_master_current ON commerce_subscriptions(subject_partner_id)
          WHERE kind='master' AND state IN ('active','past_due','restricted','suspended');

        CREATE TABLE commerce_subscription_slots (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          subscription_id uuid NOT NULL REFERENCES commerce_subscriptions(id) ON DELETE RESTRICT,
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          mac char(17) NOT NULL CHECK(mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
          activation_id uuid NOT NULL REFERENCES activations(id) ON DELETE RESTRICT,
          linked_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
          CHECK(released_at IS NULL OR released_at >= linked_at)
        );
        CREATE UNIQUE INDEX ux_commerce_slot_active_mac ON commerce_subscription_slots(partner_id,mac)
          WHERE released_at IS NULL;
        CREATE UNIQUE INDEX ux_commerce_slot_subscription_mac ON commerce_subscription_slots(subscription_id,mac)
          WHERE released_at IS NULL;
        CREATE INDEX idx_commerce_slots_sub ON commerce_subscription_slots(subscription_id,released_at);

        CREATE TABLE commerce_commission_config (
          id integer PRIMARY KEY CHECK(id = 1), max_total_bps integer NOT NULL DEFAULT 0
            CHECK(max_total_bps BETWEEN 0 AND 10000),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        INSERT INTO commerce_commission_config(id,max_total_bps) VALUES(1,0);
        CREATE TABLE commerce_commission_rules (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          beneficiary_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          basis_points integer NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(seller_partner_id,beneficiary_partner_id),
          CHECK(seller_partner_id <> beneficiary_partner_id)
        );
        CREATE TABLE commerce_commission_entries (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          sale_id uuid NOT NULL REFERENCES reseller_network_sales(id) ON DELETE RESTRICT,
          seller_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          beneficiary_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          basis_points integer NOT NULL CHECK(basis_points BETWEEN 0 AND 10000),
          credits integer NOT NULL CHECK(credits > 0),
          status varchar(12) NOT NULL DEFAULT 'settled' CHECK(status IN ('settled','reversed')),
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(sale_id,beneficiary_partner_id)
        );
        CREATE INDEX idx_commission_beneficiary ON commerce_commission_entries(beneficiary_partner_id,created_at DESC);
        ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_kind_check;
        ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check
          CHECK(kind IN ('topup','purchase','adjust','network_buy','network_sale','commission_debit','commission_credit'));
      `, { transaction });
    });
  },
  async down() {
    throw new Error('Reversão automática desativada: contratos e créditos comissionados exigem migração auditada.');
  },
};
