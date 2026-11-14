"use strict";
/** Pix entre Master e revenda: dinheiro recebido DIRETAMENTE no Mercado Pago do Master.
 * Tabelas aditivas; NÃO converte créditos e NÃO modifica vendas preexistentes.
 * A reserva de estoque é contabilizada no extrato atual e liberada só após confirmação.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        CREATE TABLE reseller_master_pix_accounts (
          partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE RESTRICT,
          provider varchar(24) NOT NULL DEFAULT 'mercadopago' CHECK(provider='mercadopago'),
          access_token_enc text NOT NULL,
          webhook_secret_enc text NOT NULL,
          merchant_id varchar(40) NOT NULL,
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE reseller_master_pix_prices (
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          months integer NOT NULL CHECK(months BETWEEN 1 AND 120),
          unit_price_cents bigint NOT NULL CHECK(unit_price_cents > 0),
          active boolean NOT NULL DEFAULT true,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY(partner_id, months)
        );
        CREATE TABLE reseller_master_pix_orders (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          buyer_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          seller_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          months integer NOT NULL CHECK(months BETWEEN 1 AND 120),
          quantity integer NOT NULL CHECK(quantity > 0),
          unit_price_cents bigint NOT NULL CHECK(unit_price_cents > 0),
          total_cents bigint NOT NULL CHECK(total_cents > 0),
          idempotency_key uuid NOT NULL,
          provider varchar(24) NOT NULL DEFAULT 'mercadopago',
          provider_ref varchar(32) UNIQUE,
          status varchar(16) NOT NULL DEFAULT 'creating'
            CHECK(status IN ('creating','pending','paid','expired','cancelled','review','refunded')),
          reserved_at timestamptz NOT NULL DEFAULT now(),
          released_at timestamptz,
          fulfilled_at timestamptz,
          paid_at timestamptz,
          expires_at timestamptz,
          qr_code text,
          ticket_url text,
          checked_at timestamptz,
          review_reason varchar(240),
          actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          CHECK(buyer_partner_id <> seller_partner_id),
          UNIQUE(buyer_partner_id, idempotency_key),
          CHECK(released_at IS NULL OR fulfilled_at IS NULL)
        );
        CREATE INDEX idx_master_pix_seller ON reseller_master_pix_orders(seller_partner_id, created_at DESC);
        CREATE INDEX idx_master_pix_buyer ON reseller_master_pix_orders(buyer_partner_id, created_at DESC);
        CREATE INDEX idx_master_pix_reconcile ON reseller_master_pix_orders(status, checked_at)
          WHERE status IN ('creating','pending','review');
      `, { transaction });
    });
  },
  async down() {
    throw new Error('Reversão automática bloqueada: cobranças Pix e reservas de estoque exigem conciliação e migração reversa auditada.');
  },
};
