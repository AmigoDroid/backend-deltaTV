'use strict';
// Exclusão irreversível solicitada: histórico de conexão e último estado persistido.
module.exports = {
  async up(q) {
    await q.dropTable('device_connection_events', { cascade: true });
    await q.dropTable('device_connection_latest', { cascade: true });
  },
  async down() {
    throw new Error('Histórico removido permanentemente. Restaure um backup para recuperar dados.');
  }
};
