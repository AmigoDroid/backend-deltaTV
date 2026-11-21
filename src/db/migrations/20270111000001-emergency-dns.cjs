'use strict';
/** Prioridade de DNS com prazo; não modifica permanentemente a origem do código. */
module.exports = {
  async up(q, S) {
    await q.createTable('code_dns_emergencies', {
      code_id: { type:S.UUID, primaryKey:true, allowNull:false, references:{model:'partner_codes',key:'id'},onDelete:'CASCADE'},
      provider_id: {type:S.UUID, allowNull:false, references:{model:'partner_providers',key:'id'},onDelete:'CASCADE'},
      expires_at: {type:S.DATE, allowNull:false},
      created_by: {type:S.UUID, allowNull:true},
      created_at: {type:S.DATE, allowNull:false, defaultValue:S.literal('CURRENT_TIMESTAMP')},
      updated_at: {type:S.DATE, allowNull:false, defaultValue:S.literal('CURRENT_TIMESTAMP')},
      notified_at: {type:S.DATE, allowNull:true},
    });
    await q.addIndex('code_dns_emergencies',['expires_at','notified_at'],{name:'code_dns_emergencies_expiry_idx'});
  },
  async down(q) { await q.dropTable('code_dns_emergencies'); },
};
