"use strict";
// Idempotent when an earlier upgrade deployment has already added this column.
module.exports = {
 async up(q,S) {
  const columns=await q.describeTable('service_plan_catalogs');
  if(!columns.hidden_from_network)await q.addColumn('service_plan_catalogs','hidden_from_network',
    {type:S.BOOLEAN,allowNull:false,defaultValue:false});
 },
 async down(_q) { /* rollback preserves existing plan visibility configuration */ },
};
