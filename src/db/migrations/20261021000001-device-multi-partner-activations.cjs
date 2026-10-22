"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db.

/*
 * Um MAC (dispositivo) pode estar associado a VÁRIOS parceiros ao mesmo tempo.
 *
 * Antes: no máximo UMA ativação viva (status <> 'revoked') por dispositivo/MAC
 *        (ux_activations_mac_live e ux_activations_device_live).
 * Agora: uma ativação viva por (dispositivo, parceiro), mais uma ativação viva "sem parceiro"
 *        (licença individual com lista própria). Isso mantém cada vínculo identificável, bloqueável,
 *        cobrável e revogável de forma independente, e impede duplicatas do mesmo parceiro no mesmo MAC.
 *
 * Os dados existentes continuam válidos: tinham no máximo uma ativação viva por dispositivo.
 */
const UP = `
DROP INDEX IF EXISTS ux_activations_mac_live;
DROP INDEX IF EXISTS ux_activations_device_live;

CREATE UNIQUE INDEX ux_activations_device_partner_live
  ON activations (device_id, partner_id)
  WHERE status <> 'revoked' AND partner_id IS NOT NULL;

CREATE UNIQUE INDEX ux_activations_device_standalone_live
  ON activations (device_id)
  WHERE status <> 'revoked' AND partner_id IS NULL;

-- Consultas por MAC (não único): o MAC passa a poder aparecer em mais de uma ativação viva.
CREATE INDEX ix_activations_mac_live
  ON activations (mac)
  WHERE status <> 'revoked' AND mac IS NOT NULL;
`;

const DOWN = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM activations WHERE status <> 'revoked' GROUP BY device_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'down recusado: existem dispositivos com mais de uma ativação viva (vários parceiros). Nada foi apagado; revogue as extras conscientemente antes de reverter.';
  END IF;
END $$;

DROP INDEX IF EXISTS ix_activations_mac_live;
DROP INDEX IF EXISTS ux_activations_device_standalone_live;
DROP INDEX IF EXISTS ux_activations_device_partner_live;

CREATE UNIQUE INDEX ux_activations_mac_live ON activations (mac) WHERE status <> 'revoked';
CREATE UNIQUE INDEX ux_activations_device_live ON activations (device_id) WHERE status <> 'revoked';
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
