'use strict';
// Integração aditiva: pedidos existentes continuam com conferência manual.
module.exports={
  async up(q){await q.sequelize.transaction(async transaction=>{await q.sequelize.query(`
    CREATE TABLE partner_portal_payment_settings (
      singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
      default_gateway varchar(16) NOT NULL DEFAULT 'manual'
        CHECK(default_gateway IN ('manual','infinitepay','mercadopago')),
      updated_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO partner_portal_payment_settings(singleton_id) VALUES(1);
    ALTER TABLE partner_portal_stock_orders
      ADD COLUMN payment_gateway varchar(16) NOT NULL DEFAULT 'manual'
        CHECK(payment_gateway IN ('manual','infinitepay','mercadopago')),
      ADD COLUMN checkout_url text,
      ADD COLUMN pix_copy_paste text,
      ADD COLUMN provider_ref varchar(160),
      ADD COLUMN payment_transaction_nsu varchar(160),
      ADD COLUMN payment_slug varchar(160),
      ADD COLUMN payment_expires_at timestamptz,
      ADD COLUMN payment_verified_at timestamptz;
    CREATE UNIQUE INDEX ux_portal_stock_order_gateway_transaction
      ON partner_portal_stock_orders(payment_gateway,payment_transaction_nsu)
      WHERE payment_transaction_nsu IS NOT NULL;
    -- O CHECK antigo exige approved_by mesmo para um pagamento confirmado por API.
    -- Identifica a restrição pelo seu conteúdo, sem assumir nome gerado pelo PostgreSQL.
    DO $$ DECLARE con record; BEGIN
      FOR con IN SELECT conname FROM pg_constraint
        WHERE conrelid='partner_portal_stock_orders'::regclass AND contype='c'
          AND pg_get_constraintdef(oid) LIKE '%approved_by%'
          AND pg_get_constraintdef(oid) LIKE '%settlement_ref%'
      LOOP EXECUTE format('ALTER TABLE partner_portal_stock_orders DROP CONSTRAINT %I',con.conname); END LOOP;
    END $$;
    ALTER TABLE partner_portal_stock_orders
      ADD CONSTRAINT portal_stock_order_paid_proof CHECK(
        status <> 'paid' OR (settlement_ref IS NOT NULL AND settled_at IS NOT NULL
          AND (approved_by IS NOT NULL OR
            (payment_gateway IN ('infinitepay','mercadopago') AND payment_verified_at IS NOT NULL)))
      );
  `,{transaction});});},
  async down(){throw new Error('Migração financeira aditiva: rollback exige plano de reconciliação dos pagamentos; não é automático.');}
};
