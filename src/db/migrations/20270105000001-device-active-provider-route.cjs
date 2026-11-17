'use strict';
/** Roteamento atual, uma linha por ativação. NÃO é auditoria nem histórico. */
module.exports = {
  async up(q,S) {
    await q.createTable('device_provider_routes', {
      activation_id: {type:S.UUID,allowNull:false,primaryKey:true,references:{model:'activations',key:'id'},onDelete:'CASCADE'},
      provider_id: {type:S.UUID,allowNull:false},
      updated_at: {type:S.DATE,allowNull:false},
    });
    await q.addIndex('device_provider_routes',['provider_id'],{name:'device_provider_routes_provider_idx'});
  },
  async down(q) { await q.dropTable('device_provider_routes'); },
};
