"use strict";
/*
 * Modelo de cobrança "none" (sem mensalidade): revendedor que só compra licenças não paga mensalidade à plataforma.
 *  - Libera 'none' na CHECK de partners.billing_model.
 *  - Revendedores existentes que estavam em "mensalidade fixa de R$ 0,00" passam para "none".
 *  - Faturas de R$ 0,00 sem pagamento (geradas antes desta correção) são canceladas: não podem mais vencer nem suspender ninguém.
 * O código também deixou de gerar fatura de valor zero, em qualquer modelo.
 */
const UP = `
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'partners'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%billing_model%'
  LOOP
    EXECUTE format('ALTER TABLE partners DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE partners ADD CONSTRAINT partners_billing_model_check CHECK (billing_model IN ('fixed','per_device','tiered','none'));
UPDATE partners SET billing_model = 'none' WHERE kind = 'reseller' AND billing_model = 'fixed' AND monthly_fee_cents = 0;
UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE amount_cents = 0 AND paid_cents = 0 AND status IN ('open','partial','overdue');
`;
const DOWN = `
UPDATE partners SET billing_model = 'fixed' WHERE billing_model = 'none';
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_billing_model_check;
ALTER TABLE partners ADD CONSTRAINT partners_billing_model_check CHECK (billing_model IN ('fixed','per_device','tiered'));
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
