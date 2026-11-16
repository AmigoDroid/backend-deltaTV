'use strict';
/** New portal access sales do not debit/grant inventory. Existing financial
 * records and outstanding legacy reservations retain their original semantics. */
module.exports={
 async up(q){await q.sequelize.transaction(async transaction=>{
  await q.sequelize.query(`ALTER TABLE partner_portal_sales_invitations
    ADD COLUMN IF NOT EXISTS stock_reserved boolean NOT NULL DEFAULT true;
   ALTER TABLE partner_portal_stock_orders
    ADD COLUMN IF NOT EXISTS service_access_only boolean NOT NULL DEFAULT false;`,{transaction});
 });},
 async down(){throw new Error('Não reverter: convites de serviço sem estoque podem existir.');}
};
