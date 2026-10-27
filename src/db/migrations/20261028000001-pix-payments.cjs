"use strict";
/*
 * Pagamentos via Pix.
 *
 *  - license_prices: preço de venda de cada duração de licença (meses). partner_id NULL = tabela geral;
 *    partner_id preenchido = preço combinado só com aquele revendedor (sobrepõe a geral; active=false esconde a duração
 *    para ele). O unique usa COALESCE porque NULL não conflita em UNIQUE comum.
 *  - pix_charges: cada QR Code gerado. purpose = 'invoice' (mensalidade de parceiro de conteúdo) ou 'stock'
 *    (compra de licenças para o estoque do revendedor). É o registro do que foi cobrado, do que o provedor confirmou
 *    e se o pedido já foi entregue (fulfilled_at). Valores sempre em centavos.
 *
 * Nenhuma tabela existente é alterada: faturas, pagamentos e estoque seguem como estão.
 */
const UP = `
CREATE TABLE license_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  months int NOT NULL CHECK (months BETWEEN 1 AND 120),
  price_cents int NOT NULL CHECK (price_cents > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_license_prices_scope_months
  ON license_prices (COALESCE(partner_id, '00000000-0000-0000-0000-000000000000'::uuid), months);

CREATE TABLE pix_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  purpose varchar(10) NOT NULL CHECK (purpose IN ('invoice','stock')),
  invoice_id uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  months int CHECK (months IS NULL OR months BETWEEN 1 AND 120),
  quantity int CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 10000),
  unit_price_cents int CHECK (unit_price_cents IS NULL OR unit_price_cents > 0),
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  provider varchar(30) NOT NULL,
  provider_ref varchar(120),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','expired','cancelled','failed','review','refunded')),
  qr_code text,
  qr_code_base64 text,
  ticket_url text,
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  paid_amount_cents int,
  fulfilled_at timestamptz,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  error varchar(500),
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (purpose = 'invoice' AND invoice_id IS NOT NULL AND months IS NULL AND quantity IS NULL)
    OR
    (purpose = 'stock' AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NOT NULL AND unit_price_cents IS NOT NULL)
  )
);
-- Um mesmo pagamento do provedor nunca pode estar em duas cobranças.
CREATE UNIQUE INDEX ux_pix_charges_provider_ref ON pix_charges (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX ix_pix_charges_partner ON pix_charges (partner_id, created_at DESC);
CREATE INDEX ix_pix_charges_invoice ON pix_charges (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX ix_pix_charges_pending ON pix_charges (expires_at) WHERE status = 'pending';
`;

const DOWN = `
-- Recusa se já houve dinheiro recebido: apagar apagaria o único registro da compra (o estoque/fatura já foram alterados).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pix_charges WHERE status IN ('paid','review','refunded')) THEN
    RAISE EXCEPTION 'down recusado: existem cobranças Pix pagas. Nada foi apagado; exporte/arquive pix_charges antes de reverter.';
  END IF;
END $$;
DROP TABLE IF EXISTS pix_charges;
DROP TABLE IF EXISTS license_prices;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
