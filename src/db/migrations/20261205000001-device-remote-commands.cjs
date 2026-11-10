'use strict';
// Comandos remotos persistentes: somente novos aplicativos fazem ACK; nunca modifica rotas legadas.
module.exports = {
  async up(q, S) {
    await q.createTable('device_remote_commands', {
      id: { type: S.UUID, primaryKey: true, allowNull: false },
      activation_id: { type: S.UUID, allowNull: false, references: { model: 'activations', key: 'id' }, onDelete: 'CASCADE' },
      device_id: { type: S.UUID, allowNull: false, references: { model: 'devices', key: 'id' }, onDelete: 'CASCADE' },
      type: { type: S.STRING(24), allowNull: false },
      target_activation_id: { type: S.UUID, allowNull: true },
      status: { type: S.STRING(20), allowNull: false, defaultValue: 'pending' },
      actor_type: { type: S.STRING(24), allowNull: false },
      actor_id: { type: S.STRING(90), allowNull: false },
      note: { type: S.STRING(300), allowNull: true },
      delivery_count: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      transport: { type: S.STRING(24), allowNull: true },
      error_code: { type: S.STRING(64), allowNull: true },
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      delivered_at: { type: S.DATE },
      executed_at: { type: S.DATE },
      expires_at: { type: S.DATE, allowNull: false },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });
    await q.addIndex('device_remote_commands', ['activation_id', 'created_at'], { name: 'device_commands_activation_history' });
    await q.addIndex('device_remote_commands', ['activation_id', 'status', 'expires_at'], { name: 'device_commands_pending' });
    await q.addIndex('device_remote_commands', ['created_at'], { name: 'device_commands_retention' });
  },
  async down(q) { await q.dropTable('device_remote_commands'); }
};
