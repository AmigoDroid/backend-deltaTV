"use strict";
/** Hierarquia de revendas. Migração ADITIVA: contas atuais continuam independentes.
 * Estoque e crédito preexistentes continuam a ser as fontes únicas de saldos.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(`
        ALTER TABLE partners ADD COLUMN distribution_role varchar(12) NOT NULL DEFAULT 'reseller';
        ALTER TABLE partners ADD CONSTRAINT ck_partner_distribution_role CHECK (distribution_role IN ('reseller','master'));
        ALTER TABLE partners ADD COLUMN parent_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT;
        ALTER TABLE partners ADD CONSTRAINT ck_partner_not_own_parent CHECK (parent_partner_id IS NULL OR parent_partner_id <> id);
        CREATE INDEX idx_partners_distribution_parent ON partners(parent_partner_id) WHERE parent_partner_id IS NOT NULL;
        CREATE TABLE reseller_network_policies (
          partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
          can_invite boolean NOT NULL DEFAULT false,
          can_sell boolean NOT NULL DEFAULT false,
          can_promote boolean NOT NULL DEFAULT false,
          max_children int NOT NULL DEFAULT 100 CHECK (max_children BETWEEN 0 AND 5000),
          max_depth int NOT NULL DEFAULT 4 CHECK (max_depth BETWEEN 1 AND 12),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE reseller_network_resources (
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          resource varchar(24) NOT NULL CHECK(resource IN ('servers','codes','devices','clients','stock','credits','web','white_label','remote')),
          enabled boolean NOT NULL DEFAULT true,
          limit_value int CHECK(limit_value IS NULL OR (limit_value BETWEEN 0 AND 10000)),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(partner_id,resource)
        );
        CREATE TABLE reseller_network_prices (
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          months int NOT NULL CHECK (months BETWEEN 1 AND 120),
          price_credits int NOT NULL CHECK (price_credits BETWEEN 1 AND 1000000),
          active boolean NOT NULL DEFAULT true,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(partner_id,months)
        );
        CREATE TABLE reseller_network_invites (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          issuer_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          token_hash char(64) NOT NULL UNIQUE,
          expires_at timestamptz NOT NULL,
          max_uses int NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
          uses int NOT NULL DEFAULT 0 CHECK (uses >= 0 AND uses <= max_uses),
          revoked_at timestamptz,
          created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX idx_network_invites_issuer ON reseller_network_invites(issuer_partner_id,created_at DESC);
        CREATE TABLE reseller_network_sales (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          buyer_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          months int NOT NULL CHECK (months BETWEEN 1 AND 120),
          quantity int NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
          unit_price_credits int NOT NULL CHECK (unit_price_credits > 0),
          total_credits bigint NOT NULL CHECK (total_credits > 0),
          transfer_id uuid NOT NULL UNIQUE,
          idempotency_key uuid NOT NULL,
          actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(buyer_partner_id,idempotency_key),
          CHECK(seller_partner_id <> buyer_partner_id)
        );
        CREATE INDEX idx_network_sales_seller_created ON reseller_network_sales(seller_partner_id,created_at DESC);
        CREATE INDEX idx_network_sales_buyer_created ON reseller_network_sales(buyer_partner_id,created_at DESC);
        ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_kind_check;
        ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK (kind IN ('topup','purchase','adjust','network_buy','network_sale'));
      `, { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction) => {
      // Não apaga vendas, convites ou árvores reais em um rollback acidental.
      await q.sequelize.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM reseller_network_sales LIMIT 1)
          OR EXISTS (SELECT 1 FROM partners WHERE parent_partner_id IS NOT NULL OR distribution_role='master' LIMIT 1)
          OR EXISTS (SELECT 1 FROM reseller_network_invites LIMIT 1)
          OR EXISTS (SELECT 1 FROM reseller_network_prices LIMIT 1)
          OR EXISTS (SELECT 1 FROM reseller_network_resources LIMIT 1)
        THEN RAISE EXCEPTION 'Rollback recusado: rede de revendas já possui dados; faça migração reversa específica.'; END IF;
      END $$;`, { transaction });
      await q.sequelize.query(`
        DROP TABLE reseller_network_sales;
        DROP TABLE reseller_network_invites;
        DROP TABLE reseller_network_prices;
        DROP TABLE reseller_network_resources;
        DROP TABLE reseller_network_policies;
        DROP INDEX IF EXISTS idx_partners_distribution_parent;
        ALTER TABLE partners DROP CONSTRAINT ck_partner_not_own_parent;
        ALTER TABLE partners DROP COLUMN parent_partner_id;
        ALTER TABLE partners DROP CONSTRAINT ck_partner_distribution_role;
        ALTER TABLE partners DROP COLUMN distribution_role;
        ALTER TABLE credit_ledger DROP CONSTRAINT credit_ledger_kind_check;
        ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_kind_check CHECK (kind IN ('topup','purchase','adjust'));
      `, { transaction });
    });
  },
};
