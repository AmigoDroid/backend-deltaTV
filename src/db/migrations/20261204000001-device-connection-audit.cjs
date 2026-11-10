'use strict';
module.exports = {
 async up(q, S) {
  const columns = {
   id: {type:S.UUID, primaryKey:true, allowNull:false},
   activation_id:{type:S.UUID,allowNull:false,references:{model:'activations',key:'id'},onDelete:'CASCADE'},
   session_id:{type:S.UUID,allowNull:true}, partner_id:{type:S.UUID}, reseller_id:{type:S.UUID},
   source:{type:S.STRING(16),allowNull:false}, state:{type:S.STRING(32),allowNull:false},
   origin:{type:S.STRING(512)}, selected_origin:{type:S.STRING(512)}, provider_id:{type:S.UUID},
   client_family:{type:S.INTEGER}, upstream_family:{type:S.INTEGER}, latency_ms:{type:S.INTEGER},
   transport:{type:S.STRING(16)}, status_code:{type:S.INTEGER}, error_code:{type:S.STRING(64)},
   position:{type:S.INTEGER}, build:{type:S.STRING(32)}, playback_id:{type:S.UUID},
   created_at:{type:S.DATE,allowNull:false,defaultValue:S.literal('CURRENT_TIMESTAMP')}
  };
  await q.createTable('device_connection_events', columns);
  await q.createTable('device_connection_latest', {...columns, last_event_at:{type:S.DATE,allowNull:false,defaultValue:S.literal('CURRENT_TIMESTAMP')}});
  await q.addIndex('device_connection_latest',['activation_id','source'],{unique:true,name:'connection_latest_source'});
  await q.addIndex('device_connection_events',['activation_id','created_at'],{name:'connection_activation_time'});
  await q.addIndex('device_connection_events',['activation_id','source','created_at'],{name:'connection_source_time'});
  await q.addIndex('device_connection_events',['created_at'],{name:'connection_retention'});
 },
 async down(q){await q.dropTable('device_connection_latest');await q.dropTable('device_connection_events');}
};
