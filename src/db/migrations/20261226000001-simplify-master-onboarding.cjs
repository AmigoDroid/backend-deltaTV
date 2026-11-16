'use strict';
/** Cadastro de Masters gratuitos: primeira compra pode não existir. Preserva pedidos anteriores. */
module.exports={
 async up(q){await q.sequelize.transaction(async t=>{
  await q.sequelize.query(`ALTER TABLE partner_portal_master_packages
    ALTER COLUMN first_order_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS created_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL;`,{transaction:t});
 });},
 async down(){throw new Error('Migração forward-only: preserve concessões gratuitas e histórico.');}
};
