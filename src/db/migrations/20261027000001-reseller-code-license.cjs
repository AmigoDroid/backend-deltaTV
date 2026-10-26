"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db.

/*
 * Código do revendedor atrelado a uma licença do ESTOQUE dele.
 *
 *  - partner_codes.license_months: duração (meses) da licença que este código consome do estoque do dono quando um
 *    dispositivo é ativado com ele. NULL = código sem licença (parceria de conteúdo: comportamento de sempre).
 *  - activations.granted_license_id: licença concedida a ESTA ativação (nasceu do estoque do revendedor). É uma coluna
 *    separada de license_id de propósito: license_id continua significando "licença individual com lista própria" e
 *    nada do que já existe (fontes, lista própria, remoção de lista) passa a tratar a ativação do revendedor como tal.
 *  - Uma licença concedida só pode estar em UMA ativação viva por vez (índice único parcial). Ao transferir para outro
 *    MAC a ativação antiga é revogada na mesma transação e o prazo restante segue com a licença.
 *
 * Nada existente muda: as duas colunas são NULLABLE e os registros atuais ficam NULL.
 */
const UP = `
ALTER TABLE partner_codes
  ADD COLUMN license_months int,
  ADD CONSTRAINT ck_partner_codes_license_months CHECK (license_months IS NULL OR license_months BETWEEN 1 AND 120);

ALTER TABLE activations
  ADD COLUMN granted_license_id uuid REFERENCES licenses(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX ux_activations_granted_license_live
  ON activations (granted_license_id)
  WHERE granted_license_id IS NOT NULL AND status <> 'revoked';

CREATE INDEX ix_activations_granted_license
  ON activations (granted_license_id)
  WHERE granted_license_id IS NOT NULL;
`;

const DOWN = `
DROP INDEX IF EXISTS ix_activations_granted_license;
DROP INDEX IF EXISTS ux_activations_granted_license_live;
ALTER TABLE activations DROP COLUMN IF EXISTS granted_license_id;
ALTER TABLE partner_codes DROP CONSTRAINT IF EXISTS ck_partner_codes_license_months;
ALTER TABLE partner_codes DROP COLUMN IF EXISTS license_months;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
