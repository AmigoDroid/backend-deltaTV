'use strict';
// Apenas totais horários, não respostas HTTP individuais ou tráfego de cliente.
module.exports = {
  async up(q, S) {
    await q.createTable('provider_health_hourly', {
      provider_id: { type: S.UUID, allowNull: false, primaryKey: true,
        references: { model: 'partner_providers', key: 'id' }, onDelete: 'CASCADE' },
      bucket: { type: S.DATE, allowNull: false, primaryKey: true },
      probes: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ok_probes: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      slow_probes: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      latency_total_ms: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
    });
    await q.addIndex('provider_health_hourly', ['bucket'], { name: 'idx_provider_health_hourly_retention' });
  },
  async down(q) { await q.dropTable('provider_health_hourly'); },
};
