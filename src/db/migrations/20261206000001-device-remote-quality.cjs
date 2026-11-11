'use strict';
module.exports = {
  async up(q, S) {
    await q.addColumn('device_remote_commands','payload', {type:S.JSONB,allowNull:true});
    await q.addColumn('device_remote_commands','result', {type:S.JSONB,allowNull:true});
    await q.createTable('device_failover_requests', {
      activation_id:{type:S.UUID, primaryKey:true,allowNull:false,references:{model:'activations',key:'id'},onDelete:'CASCADE'},
      avoid_provider_id:{type:S.UUID, allowNull:false},
      requested_at:{type:S.DATE,allowNull:false},
      expires_at:{type:S.DATE,allowNull:false}
    });
    await q.addIndex('device_failover_requests',['expires_at'],{name:'device_failover_expiry'});
    await q.createTable('provider_quality_alerts', {
      id:{type:S.UUID,primaryKey:true,allowNull:false},
      provider_id:{type:S.UUID,allowNull:false,references:{model:'partner_providers',key:'id'},onDelete:'CASCADE'},
      partner_id:{type:S.UUID,allowNull:false},
      severity:{type:S.STRING(16),allowNull:false},
      affected_devices:{type:S.INTEGER,allowNull:false},
      sample_devices:{type:S.INTEGER,allowNull:false},
      first_seen_at:{type:S.DATE,allowNull:false},
      last_seen_at:{type:S.DATE,allowNull:false},
      resolved_at:{type:S.DATE,allowNull:true},
    });
    await q.addIndex('provider_quality_alerts',['provider_id','resolved_at'],{name:'quality_open_per_provider'});
    await q.addIndex('provider_quality_alerts',['partner_id','last_seen_at'],{name:'quality_partner_recent'});
    await q.sequelize.query(`CREATE UNIQUE INDEX quality_unique_open_provider ON provider_quality_alerts (provider_id) WHERE resolved_at IS NULL`);
  },
  async down(q) {
    await q.dropTable('provider_quality_alerts');
    await q.dropTable('device_failover_requests');
    await q.removeColumn('device_remote_commands','result');
    await q.removeColumn('device_remote_commands','payload');
  }
};
