"use strict";
const {randomUUID}=require("node:crypto");
// Migração aditiva: convites antigos continuam de uso único; token histórico não muda.
module.exports={
 async up(q,S){await q.sequelize.transaction(async transaction=>{
   await q.changeColumn('admin_network_invitations','email',{type:S.STRING(200),allowNull:true},{transaction});
   await q.addColumn('admin_network_invitations','kind',{type:S.STRING(10),allowNull:false,defaultValue:'content'},{transaction});
   await q.sequelize.query(`ALTER TABLE admin_network_invitations ADD CONSTRAINT ck_admin_network_invite_kind CHECK (kind IN ('content','reseller'))`,{transaction});
   await q.addColumn('admin_network_invitations','label',{type:S.STRING(120)},{transaction});
   await q.addColumn('admin_network_invitations','max_uses',{type:S.INTEGER,allowNull:true,defaultValue:1},{transaction});
   await q.addColumn('admin_network_invitations','use_count',{type:S.INTEGER,allowNull:false,defaultValue:0},{transaction});
   await q.addColumn('admin_network_invitations','last_used_at',{type:S.DATE},{transaction});
   await q.sequelize.query(`UPDATE admin_network_invitations SET use_count=1 WHERE accepted_at IS NOT NULL`,{transaction});
   await q.sequelize.query(`ALTER TABLE admin_network_invitations ADD CONSTRAINT ck_admin_network_invite_uses CHECK (use_count >= 0 AND (max_uses IS NULL OR (max_uses >= 1 AND use_count <= max_uses)))`,{transaction});
   await q.sequelize.query(`ALTER TABLE admin_network_invitations ADD CONSTRAINT ck_admin_network_invite_email_multi CHECK (email IS NULL OR max_uses = 1)`,{transaction});
   await q.createTable('admin_network_invite_redemptions',{
     id:{type:S.UUID,allowNull:false,primaryKey:true},
     invitation_id:{type:S.UUID,allowNull:false,references:{model:'admin_network_invitations',key:'id'},onDelete:'RESTRICT'},
     partner_id:{type:S.UUID,allowNull:true,references:{model:'partners',key:'id'},onDelete:'SET NULL'},
     email:{type:S.STRING(200),allowNull:false},
     created_at:{type:S.DATE,allowNull:false,defaultValue:S.literal('CURRENT_TIMESTAMP')}
   },{transaction});
   await q.addIndex('admin_network_invite_redemptions',['invitation_id','created_at'],{name:'idx_network_invite_redemption_created',transaction});
   await q.addIndex('admin_network_invite_redemptions',['partner_id'],{unique:true,name:'uq_network_invite_redemption_partner',transaction});
   // Convites pessoais aceitos antes desta atualização também aparecem no histórico.
   const [legacy]=await q.sequelize.query(`SELECT id, partner_id, email, accepted_at
     FROM admin_network_invitations WHERE accepted_at IS NOT NULL AND partner_id IS NOT NULL AND email IS NOT NULL`,{transaction});
   for(let i=0;i<legacy.length;i+=200){
     await q.bulkInsert('admin_network_invite_redemptions',legacy.slice(i,i+200).map(v=>({
       id:randomUUID(),invitation_id:v.id,partner_id:v.partner_id,email:v.email,created_at:v.accepted_at,
     })),{transaction});
   }
 });},
 async down(){throw Error('Convites emitidos não podem ser removidos automaticamente. Faça revisão manual.');}
};
