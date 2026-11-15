"use strict";
/** Meios de recebimento por vendedor da rede: Mercado Pago, InfinitePay e Pix próprio (chave do vendedor).
 * ADITIVA: copia as contas Mercado Pago já configuradas e NÃO altera cobranças, estoque nem preços existentes.
 * A tabela antiga reseller_master_pix_accounts fica preservada (somente leitura, legado).
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(`
        CREATE TABLE reseller_payment_gateways (
          partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
          provider varchar(16) NOT NULL CHECK (provider IN ('mercadopago','infinitepay','manual_pix')),
          access_token_enc text,
          webhook_secret_enc text,
          account_ref varchar(80) NOT NULL,
          receiver_name varchar(25),
          receiver_city varchar(15),
          active boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (partner_id, provider),
          CHECK (provider <> 'mercadopago' OR (access_token_enc IS NOT NULL AND webhook_secret_enc IS NOT NULL)),
          CHECK (provider <> 'manual_pix' OR (receiver_name IS NOT NULL AND receiver_city IS NOT NULL))
        );
        INSERT INTO reseller_payment_gateways(partner_id,provider,access_token_enc,webhook_secret_enc,account_ref,active,created_at,updated_at)
          SELECT partner_id,'mercadopago',access_token_enc,webhook_secret_enc,merchant_id,active,created_at,updated_at
            FROM reseller_master_pix_accounts;
        ALTER TABLE reseller_master_pix_orders ALTER COLUMN provider_ref TYPE varchar(64);
        ALTER TABLE reseller_master_pix_orders ADD CONSTRAINT ck_master_pix_order_provider
          CHECK (provider IN ('mercadopago','infinitepay','manual_pix'));
        ALTER TABLE reseller_master_pix_orders
          ADD COLUMN checkout_url text,
          ADD COLUMN provider_txn varchar(80),
          ADD COLUMN provider_slug varchar(80),
          ADD COLUMN payer_claimed_at timestamptz,
          ADD COLUMN confirmed_by_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL;
        CREATE UNIQUE INDEX uq_master_pix_provider_txn ON reseller_master_pix_orders(provider, provider_txn)
          WHERE provider_txn IS NOT NULL;
      `, { transaction });
    });
  },
  async down() {
    throw new Error('Reversão automática bloqueada: há credenciais de recebimento e cobranças de vários provedores; use migração reversa auditada.');
  },
};
