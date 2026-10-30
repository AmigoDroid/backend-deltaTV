"use strict";
/*
 * Player Web separado, licenciado como os apps de TV.
 *
 *  - web_accesses: um código de acesso (2 letras + 6 dígitos, ex.: AB123456) gerado pelo revendedor (ou pelo admin).
 *    Cada acesso tem o seu próprio dispositivo web (devices.platform = 'web', MAC virtual), a sua ativação e a sua
 *    licença (estoque do revendedor), exatamente como uma TV. O código NÃO é guardado em claro: code_hash confere o
 *    login e code_enc (AES-GCM) deixa o dono consultá-lo de novo no painel.
 *  - activations.delivery_modes: modo de entrega POR TIPO ({api, live, movie, series} -> proxy|redirect). NULL = automático.
 */
const UP = `
ALTER TABLE activations ADD COLUMN delivery_modes jsonb;

CREATE TABLE web_accesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partners(id) ON DELETE SET NULL,
  device_id uuid NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL UNIQUE,
  code_enc text NOT NULL,
  label varchar(160),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','revoked')),
  status_reason varchar(500),
  created_by uuid,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_web_accesses_partner ON web_accesses (partner_id, created_at DESC);
`;
const DOWN = `
DROP TABLE IF EXISTS web_accesses;
ALTER TABLE activations DROP COLUMN IF EXISTS delivery_modes;
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
