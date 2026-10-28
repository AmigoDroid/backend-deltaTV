"use strict";
/*
 * Modo de entrega (proxy/redirect) definido POR DISPOSITIVO pelo superadmin.
 * NULL = automático (lista própria = redirect; parceria = modo do provedor). Preenchido = vale para esta ativação.
 */
const UP = `
ALTER TABLE activations
  ADD COLUMN delivery_mode varchar(20),
  ADD CONSTRAINT activations_delivery_mode_check CHECK (delivery_mode IS NULL OR delivery_mode IN ('proxy','redirect'));
`;
const DOWN = `
ALTER TABLE activations
  DROP CONSTRAINT activations_delivery_mode_check,
  DROP COLUMN delivery_mode;
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
