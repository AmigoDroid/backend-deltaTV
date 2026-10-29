"use strict";
/*
 * Presença de dispositivos (online/offline): devices.last_seen_at já existe; este índice acelera
 * a contagem "online agora" e o filtro Online/Offline do painel (consulta por faixa recente).
 */
const UP = `CREATE INDEX IF NOT EXISTS devices_last_seen_at_idx ON devices (last_seen_at DESC) WHERE last_seen_at IS NOT NULL;`;
const DOWN = `DROP INDEX IF EXISTS devices_last_seen_at_idx;`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
