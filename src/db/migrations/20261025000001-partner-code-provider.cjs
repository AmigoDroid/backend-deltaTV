"use strict";
/*
 * Cada código curto passa a apontar para UM servidor (partner_providers) do mesmo parceiro:
 * código X => parceiro X + servidor X. Um parceiro pode ter vários códigos e vários servidores.
 *
 * Compatibilidade com clientes ativos (nenhuma ativação é tocada; os apps não mudam):
 *  - partner_codes.provider_id é NULLABLE. NULL = comportamento antigo (a ativação testa os servidores ativos
 *    do parceiro por prioridade).
 *  - Backfill: códigos de parceiros com EXATAMENTE UM servidor já ficam apontando para ele (comportamento idêntico
 *    ao de hoje, e o código não "migra" sozinho se o parceiro adicionar outro servidor depois).
 *    Parceiros com vários servidores ficam com NULL até o admin escolher o servidor de cada código.
 *  - FK composta (partner_id, provider_id) garante que o servidor pertence ao MESMO parceiro do código.
 *  - ON DELETE NO ACTION: um servidor referenciado não pode ser apagado por engano (o serviço devolve 409).
 */
const UP = `
ALTER TABLE partner_providers ADD CONSTRAINT ux_partner_providers_id_partner UNIQUE (id, partner_id);

ALTER TABLE partner_codes ADD COLUMN provider_id uuid;
ALTER TABLE partner_codes
  ADD CONSTRAINT fk_partner_codes_provider
  FOREIGN KEY (provider_id, partner_id) REFERENCES partner_providers (id, partner_id);
CREATE INDEX ix_partner_codes_provider ON partner_codes (provider_id) WHERE provider_id IS NOT NULL;

UPDATE partner_codes c
   SET provider_id = (SELECT p.id FROM partner_providers p WHERE p.partner_id = c.partner_id)
 WHERE c.provider_id IS NULL
   AND (SELECT count(*) FROM partner_providers p WHERE p.partner_id = c.partner_id) = 1;
`;

const DOWN = `
DROP INDEX IF EXISTS ix_partner_codes_provider;
ALTER TABLE partner_codes DROP CONSTRAINT IF EXISTS fk_partner_codes_provider;
ALTER TABLE partner_codes DROP COLUMN IF EXISTS provider_id;
ALTER TABLE partner_providers DROP CONSTRAINT IF EXISTS ux_partner_providers_id_partner;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
