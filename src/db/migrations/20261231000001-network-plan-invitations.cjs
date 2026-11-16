"use strict";
// Novos atributos para o catálogo JÁ EXISTENTE e convites scoped à rede.
module.exports = {
 async up(q,S){await q.sequelize.transaction(async transaction=>{
   await q.addColumn('service_plan_catalogs','activation_limit',{type:S.INTEGER,allowNull:true,defaultValue:100},{transaction});
   await q.addColumn('service_plan_catalogs','validity_days',{type:S.INTEGER,allowNull:false,defaultValue:30},{transaction});
   await q.createTable('admin_network_invitations',{
      id:{type:S.UUID,allowNull:false,primaryKey:true},
      owner_admin_id:{type:S.UUID,allowNull:true,references:{model:'admin_users',key:'id'},onDelete:'RESTRICT'},
      invited_by_id:{type:S.UUID,allowNull:false,references:{model:'admin_users',key:'id'},onDelete:'RESTRICT'},
      email:{type:S.STRING(200),allowNull:false},
      plan_key:{type:S.STRING(32),allowNull:false,references:{model:'service_plan_catalogs',key:'key'},onDelete:'RESTRICT'},
      plan_fingerprint:{type:S.CHAR(64),allowNull:false},
      token_hash:{type:S.CHAR(64),allowNull:false},
      expires_at:{type:S.DATE,allowNull:false},
      accepted_at:{type:S.DATE},revoked_at:{type:S.DATE},partner_id:{type:S.UUID, references:{model:'partners',key:'id'},onDelete:'SET NULL'},
      created_at:{type:S.DATE,allowNull:false,defaultValue:S.literal('CURRENT_TIMESTAMP')},
      updated_at:{type:S.DATE,allowNull:false,defaultValue:S.literal('CURRENT_TIMESTAMP')}
   },{transaction});
   await q.addIndex('admin_network_invitations',['token_hash'],{unique:true,name:'uq_admin_net_invite_token',transaction});
   await q.addIndex('admin_network_invitations',['owner_admin_id','created_at'],{name:'idx_admin_net_invite_owner',transaction});
   await q.sequelize.query(`ALTER TABLE service_plan_catalogs ADD CONSTRAINT ck_catalog_activation_limit CHECK (activation_limit IS NULL OR activation_limit >= 0)`,{transaction});
   await q.sequelize.query(`ALTER TABLE service_plan_catalogs ADD CONSTRAINT ck_catalog_validity_days CHECK (validity_days >= 1 AND validity_days <= 3660)`,{transaction});
 });},
 async down(){throw new Error('Reversão requer revisão dos convites emitidos; não remover registros automaticamente.');}
};
