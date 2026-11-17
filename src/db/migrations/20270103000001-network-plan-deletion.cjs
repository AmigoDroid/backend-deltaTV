"use strict";
module.exports = {
 async up(q,S){
  await q.sequelize.transaction(async transaction=>{
   await q.addColumn("service_plan_catalogs","deleted_at",{type:S.DATE,allowNull:true},{transaction});
   await q.addIndex("service_plan_catalogs",["owner_admin_id","deleted_at"],{name:"idx_network_plans_visible",transaction});
  });
 },
 async down(q){
  await q.sequelize.transaction(async transaction=>{
   await q.removeIndex("service_plan_catalogs","idx_network_plans_visible",{transaction});
   await q.removeColumn("service_plan_catalogs","deleted_at",{transaction});
  });
 }
};
