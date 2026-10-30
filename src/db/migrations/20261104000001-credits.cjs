"use strict";
/*
 * Crédito pré-pago para compra/renovação de licenças (carteira do revendedor).
 *
 * NÃO é moeda: o crédito só entra (recarga por Pix ou ajuste do admin) e só sai para comprar licença. Não há
 * transferência entre parceiros, nem venda de volta, nem saque.
 *
 *  - credit_wallets : saldo por parceiro (inteiro, em créditos). CHECK impede saldo negativo.
 *  - credit_ledger  : extrato imutável (recarga, compra, ajuste), com o câmbio/preço usados na hora.
 *  - credit_rates   : câmbio definido pelo admin = centavos de R$ por 1 crédito. partner_id NULL = geral; preenchido = só dele.
 *  - credit_prices  : preço de 1 licença (por duração) em créditos. partner_id NULL = geral; preenchido = só dele.
 *  - pix_charges.purpose ganha 'credit' (quantity = créditos, unit_price_cents = câmbio usado).
 */
const UP = `
CREATE TABLE credit_wallets (
  partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  kind varchar(16) NOT NULL CHECK (kind IN ('topup','purchase','adjust')),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  rate_cents int,
  months int,
  quantity int,
  unit_price_credits int,
  charge_id uuid REFERENCES pix_charges(id) ON DELETE SET NULL,
  note varchar(300),
  actor_user_id uuid,
  actor_name varchar(160),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_credit_ledger_partner ON credit_ledger (partner_id, created_at DESC);
-- Uma recarga Pix só pode creditar uma vez (idempotência mesmo com webhook + polling + conciliação juntos).
CREATE UNIQUE INDEX ux_credit_ledger_topup_charge ON credit_ledger (charge_id) WHERE kind = 'topup' AND charge_id IS NOT NULL;

CREATE TABLE credit_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  rate_cents int NOT NULL CHECK (rate_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_credit_rates_scope
  ON credit_rates (COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE credit_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  months int NOT NULL CHECK (months BETWEEN 1 AND 120),
  price_credits int NOT NULL CHECK (price_credits > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_credit_prices_scope_months
  ON credit_prices (COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), months);

ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_values;
ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_check;
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_check CHECK (
  (purpose = 'invoice' AND partner_id IS NOT NULL AND invoice_id IS NOT NULL AND months IS NULL AND quantity IS NULL)
  OR
  (purpose = 'stock' AND partner_id IS NOT NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NOT NULL AND unit_price_cents IS NOT NULL)
  OR
  (purpose = 'license' AND partner_id IS NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NULL
     AND unit_price_cents IS NOT NULL AND mac IS NOT NULL AND payer_email IS NOT NULL)
  OR
  (purpose = 'credit' AND partner_id IS NOT NULL AND invoice_id IS NULL AND months IS NULL AND quantity IS NOT NULL AND unit_price_cents IS NOT NULL)
);
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_values CHECK (purpose IN ('invoice','stock','license','credit'));
`;

const DOWN = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_ledger) OR EXISTS (SELECT 1 FROM pix_charges WHERE purpose = 'credit') THEN
    RAISE EXCEPTION 'down recusado: já existem créditos lançados. Exporte/arquive credit_ledger e as cobranças Pix de crédito antes de reverter.';
  END IF;
END $$;
ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_values;
ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_check;
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_check CHECK (
  (purpose = 'invoice' AND partner_id IS NOT NULL AND invoice_id IS NOT NULL AND months IS NULL AND quantity IS NULL)
  OR
  (purpose = 'stock' AND partner_id IS NOT NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NOT NULL AND unit_price_cents IS NOT NULL)
  OR
  (purpose = 'license' AND partner_id IS NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NULL
     AND unit_price_cents IS NOT NULL AND mac IS NOT NULL AND payer_email IS NOT NULL)
);
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_values CHECK (purpose IN ('invoice','stock','license'));
DROP TABLE IF EXISTS credit_prices;
DROP TABLE IF EXISTS credit_rates;
DROP TABLE IF EXISTS credit_ledger;
DROP TABLE IF EXISTS credit_wallets;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
