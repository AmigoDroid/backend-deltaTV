"use strict";
module.exports = {
 async up(q,S) {
  await q.createTable("provider_health", {
   id: { type:S.UUID, primaryKey:true, allowNull:false, defaultValue:S.literal("gen_random_uuid()") },
   provider_id:{type:S.UUID,allowNull:false,unique:true,references:{model:"partner_providers",key:"id"},onDelete:"CASCADE"},
   state:{type:S.STRING(20),allowNull:false,defaultValue:"unknown"}, latency_ms:S.INTEGER,
   last_checked_at:S.DATE,last_good_at:S.DATE,failures:{type:S.INTEGER,allowNull:false,defaultValue:0},
   successes:{type:S.INTEGER,allowNull:false,defaultValue:0},last_error:S.STRING(220),
   created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},updated_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")}
  });
  await q.createTable("code_failovers", {
   id:{type:S.UUID,primaryKey:true,allowNull:false,defaultValue:S.literal("gen_random_uuid()")},
   code_id:{type:S.UUID,allowNull:false,unique:true,references:{model:"partner_codes",key:"id"},onDelete:"CASCADE"},
   original_provider_id:{type:S.UUID},current_provider_id:{type:S.UUID},
   outage_notified_at:S.DATE,last_switched_at:S.DATE,
   created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},updated_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")}
  });
 },
 async down(q){await q.dropTable("code_failovers");await q.dropTable("provider_health");}
};
