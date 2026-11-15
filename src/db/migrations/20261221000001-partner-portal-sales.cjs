"use strict";
/** Rede comercial do PAINEL DO PARCEIRO, isolada do estoque e da rede de revendas de TV.
 * Migração aditiva; parceiros legados não recebem contratos ou restrições retroativas.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        CREATE TABLE partner_portal_sales_plans (
          code varchar(32) PRIMARY KEY CHECK(code ~ '^[a-z][a-z0-9_-]{1,31}$'),
          name varchar(120) NOT NULL,
          wholesale_cents bigint NOT NULL CHECK(wholesale_cents > 0),
          min_resale_cents bigint NOT NULL CHECK(min_resale_cents >= wholesale_cents),
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE partner_portal_sellers (
          partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE RESTRICT,
          parent_partner_id uuid REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          role varchar(16) NOT NULL CHECK(role IN ('master','submaster')),
          can_sell boolean NOT NULL DEFAULT true,
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK(parent_partner_id IS NULL OR parent_partner_id <> partner_id),
          CHECK((parent_partner_id IS NULL AND role='master') OR (parent_partner_id IS NOT NULL AND role='submaster'))
        );
        CREATE INDEX idx_portal_sellers_parent ON partner_portal_sellers(parent_partner_id);
        CREATE TABLE partner_portal_stock (
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          available_months bigint NOT NULL DEFAULT 0 CHECK(available_months >= 0),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(seller_partner_id,plan_code)
        );
        CREATE TABLE partner_portal_stock_orders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          quantity_months integer NOT NULL CHECK(quantity_months > 0),
          unit_price_cents bigint NOT NULL CHECK(unit_price_cents > 0),
          total_cents bigint NOT NULL CHECK(total_cents > 0),
          status varchar(12) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled')),
          settlement_ref varchar(120) UNIQUE,
          settlement_method varchar(32),
          approved_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          settled_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          CHECK(status <> 'paid' OR (settlement_ref IS NOT NULL AND approved_by IS NOT NULL AND settled_at IS NOT NULL))
        );
        CREATE INDEX idx_portal_orders_seller ON partner_portal_stock_orders(seller_partner_id,created_at DESC);
        CREATE TABLE partner_portal_stock_exceptions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          quantity_months integer NOT NULL CHECK(quantity_months > 0),
          reason varchar(500) NOT NULL,
          approved_by uuid NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE partner_portal_transfers (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          buyer_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          quantity_months integer NOT NULL CHECK(quantity_months > 0),
          declared_unit_price_cents bigint NOT NULL CHECK(declared_unit_price_cents >= 0),
          declared_total_cents bigint NOT NULL CHECK(declared_total_cents >= 0),
          request_id uuid NOT NULL,
          actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(seller_partner_id,request_id),
          CHECK(seller_partner_id <> buyer_partner_id)
        );
        CREATE INDEX idx_portal_transfers_buyer ON partner_portal_transfers(buyer_partner_id,created_at DESC);
        CREATE TABLE partner_portal_access_contracts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_partner_id uuid NOT NULL UNIQUE REFERENCES partners(id) ON DELETE RESTRICT,
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          start_at timestamptz NOT NULL,
          expires_at timestamptz NOT NULL,
          months_paid integer NOT NULL CHECK(months_paid > 0),
          declared_resale_cents bigint NOT NULL CHECK(declared_resale_cents >= 0),
          monthly_fee_cents bigint NOT NULL DEFAULT 0 CHECK(monthly_fee_cents >= 0),
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK(expires_at > start_at)
        );
        CREATE TABLE partner_portal_contract_events (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          contract_id uuid NOT NULL REFERENCES partner_portal_access_contracts(id) ON DELETE RESTRICT,
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          request_id uuid NOT NULL,
          months integer NOT NULL CHECK(months > 0),
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          declared_resale_cents bigint NOT NULL CHECK(declared_resale_cents >= 0),
          previous_expires_at timestamptz,
          expires_at timestamptz NOT NULL,
          actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(seller_partner_id,request_id)
        );
        CREATE INDEX idx_portal_contract_events_contract ON partner_portal_contract_events(contract_id,created_at DESC);
        CREATE TABLE partner_portal_cost_settings (
          singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
          vps_monthly_cents bigint NOT NULL DEFAULT 3000 CHECK(vps_monthly_cents >= 0),
          domain_annual_cents bigint NOT NULL DEFAULT 4000 CHECK(domain_annual_cents >= 0),
          other_monthly_cents bigint NOT NULL DEFAULT 0 CHECK(other_monthly_cents >= 0),
          proxy_cost_per_gb_cents bigint NOT NULL DEFAULT 0 CHECK(proxy_cost_per_gb_cents >= 0),
          forecast_proxy_gb_per_partner int NOT NULL DEFAULT 0 CHECK(forecast_proxy_gb_per_partner >= 0),
          target_margin_bp int NOT NULL DEFAULT 2500 CHECK(target_margin_bp BETWEEN 0 AND 8000),
          tax_bp int NOT NULL DEFAULT 0 CHECK(tax_bp BETWEEN 0 AND 2500),
          reserve_bp int NOT NULL DEFAULT 1000 CHECK(reserve_bp BETWEEN 0 AND 6000),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK(target_margin_bp+tax_bp<9000)
        );
        INSERT INTO partner_portal_cost_settings(singleton_id) VALUES (1);
        COMMENT ON TABLE partner_portal_cost_settings IS 'Estimativas configuráveis, não medição real de banda. Domínio informado como R$40/ano.';
        COMMENT ON TABLE partner_portal_stock IS 'Estoque de meses de acesso AO PAINEL DO PARCEIRO. Não é licença de TV nem crédito de ativação.';
        COMMENT ON COLUMN partner_portal_access_contracts.monthly_fee_cents IS 'Mensalidade comercial declarada; não inicia débito ou cobrança automática. Faturamento requer integração própria.';
      `, { transaction });
    });
  },
  async down() { throw new Error('Migração forward-only: preserve contratos, estoque e vendas.'); },
};
