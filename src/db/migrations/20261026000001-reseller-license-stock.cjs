"use strict";
/*
 * Estoque de licenças dos revendedores.
 *
 *  - plans.duration_months deixa de ser só 4/6/12: qualquer valor de 1 a 120 meses. Planos e licenças existentes
 *    não mudam (a regra nova é mais ampla que a antiga).
 *  - license_stock: saldo atual por (revendedor, duração em meses). quantity nunca fica negativa (CHECK), então o
 *    saldo é protegido pelo banco mesmo sob concorrência.
 *  - license_stock_ledger: extrato imutável (entrada do admin, ajuste, transferência, consumo ao aplicar num MAC).
 *    Guarda o saldo resultante e, quando existe, o valor unitário cobrado.
 *
 * Nenhuma tabela existente é alterada além do CHECK de plans; apps e ativações atuais não são tocados.
 */
const UP = `
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_duration_months_check;
ALTER TABLE plans ADD CONSTRAINT ck_plans_duration_months CHECK (duration_months BETWEEN 1 AND 120);

CREATE TABLE license_stock (
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  months int NOT NULL CHECK (months BETWEEN 1 AND 120),
  quantity int NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, months)
);

CREATE TABLE license_stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  months int NOT NULL CHECK (months BETWEEN 1 AND 120),
  delta int NOT NULL CHECK (delta <> 0),
  balance_after int NOT NULL CHECK (balance_after >= 0),
  kind varchar(16) NOT NULL CHECK (kind IN ('grant','adjust','transfer_in','transfer_out','consume')),
  counterparty_partner_id uuid REFERENCES partners(id) ON DELETE SET NULL,
  transfer_id uuid,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  license_id uuid REFERENCES licenses(id) ON DELETE SET NULL,
  unit_price_cents int CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  note varchar(500),
  actor_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  actor_name varchar(160),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_license_stock_ledger_partner ON license_stock_ledger (partner_id, created_at DESC);
CREATE INDEX ix_license_stock_ledger_transfer ON license_stock_ledger (transfer_id) WHERE transfer_id IS NOT NULL;
`;

const DOWN = `
DROP TABLE IF EXISTS license_stock_ledger;
DROP TABLE IF EXISTS license_stock;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS ck_plans_duration_months;
-- Só volta ao CHECK antigo (4/6/12) se nenhum plano usar outra duração; senão recusa sem apagar nada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM plans WHERE duration_months NOT IN (4, 6, 12)) THEN
    RAISE EXCEPTION 'down recusado: existem planos com duração fora de 4/6/12 meses. Nada foi apagado; remova ou migre esses planos antes de reverter.';
  END IF;
END $$;
ALTER TABLE plans ADD CONSTRAINT plans_duration_months_check CHECK (duration_months IN (4, 6, 12));
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
