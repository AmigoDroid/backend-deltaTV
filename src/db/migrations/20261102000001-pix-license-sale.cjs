"use strict";
/*
 * Venda de licença individual pelo SITE (cliente final, sem parceiro), paga via Pix.
 *  - pix_charges.purpose ganha 'license';
 *  - partner_id passa a aceitar NULL (cobrança do site não pertence a um parceiro);
 *  - novas colunas: mac (TV que receberá a licença), payer_email (quem paga) e license_id (licença criada/renovada ao pagar).
 * Cobranças de parceiro (invoice/stock) continuam exigindo partner_id.
 */
const UP = `
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'pix_charges'::regclass AND contype = 'c'
              AND (pg_get_constraintdef(oid) LIKE '%purpose%')
  LOOP
    EXECUTE format('ALTER TABLE pix_charges DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE pix_charges
  ALTER COLUMN partner_id DROP NOT NULL,
  ADD COLUMN mac char(17),
  ADD COLUMN payer_email varchar(200),
  ADD COLUMN license_id uuid REFERENCES licenses(id) ON DELETE SET NULL;

ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_check CHECK (
  (purpose = 'invoice' AND partner_id IS NOT NULL AND invoice_id IS NOT NULL AND months IS NULL AND quantity IS NULL)
  OR
  (purpose = 'stock' AND partner_id IS NOT NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NOT NULL AND unit_price_cents IS NOT NULL)
  OR
  (purpose = 'license' AND partner_id IS NULL AND invoice_id IS NULL AND months IS NOT NULL AND quantity IS NULL
     AND unit_price_cents IS NOT NULL AND mac IS NOT NULL AND payer_email IS NOT NULL)
);
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_values CHECK (purpose IN ('invoice','stock','license'));
CREATE INDEX ix_pix_charges_license_mac ON pix_charges (mac, created_at DESC) WHERE purpose = 'license';
`;
const DOWN = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pix_charges WHERE purpose = 'license') THEN
    RAISE EXCEPTION 'down recusado: existem cobranças Pix de licença do site. Exporte/arquive antes de reverter.';
  END IF;
END $$;
DROP INDEX IF EXISTS ix_pix_charges_license_mac;
ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_values;
ALTER TABLE pix_charges DROP CONSTRAINT IF EXISTS pix_charges_purpose_check;
ALTER TABLE pix_charges
  DROP COLUMN license_id, DROP COLUMN payer_email, DROP COLUMN mac,
  ALTER COLUMN partner_id SET NOT NULL;
ALTER TABLE pix_charges ADD CONSTRAINT pix_charges_purpose_check CHECK (purpose IN ('invoice','stock'));
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
