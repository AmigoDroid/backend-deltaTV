'use strict';
/** Uma preferência por ativação; não altera código, pool ou outras TVs. */
module.exports = {
  async up(q, S) {
    await q.createTable('device_dns_overrides', {
      activation_id: { type:S.UUID, primaryKey:true, allowNull:false, references:{model:'activations',key:'id'},onDelete:'CASCADE' },
      provider_id: { type:S.UUID, allowNull:false, references:{model:'partner_providers',key:'id'},onDelete:'CASCADE' },
      expires_at: { type:S.DATE, allowNull:false },
      created_by: { type:S.UUID, allowNull:true },
      created_at: { type:S.DATE, allowNull:false, defaultValue:S.literal('CURRENT_TIMESTAMP') },
      updated_at: { type:S.DATE, allowNull:false, defaultValue:S.literal('CURRENT_TIMESTAMP') },
      notified_at: { type:S.DATE, allowNull:true },
    });
    await q.addIndex('device_dns_overrides',['expires_at','notified_at'],{name:'device_dns_override_expiry_idx'});
  },
  async down(q) { await q.dropTable('device_dns_overrides'); },
};
