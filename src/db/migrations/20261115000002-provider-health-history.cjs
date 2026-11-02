"use strict";
// Histórico compacto: uma linha apenas quando o estado do servidor muda, nunca por heartbeat.
module.exports={
 async up(q,S){
  await q.createTable("provider_health_events",{
   id:{type:S.UUID,primaryKey:true,defaultValue:S.literal("gen_random_uuid()")},
   provider_id:{type:S.UUID,allowNull:false,references:{model:"partner_providers",key:"id"},onDelete:"CASCADE"},
   state:{type:S.STRING(20),allowNull:false},
   latency_ms:{type:S.INTEGER},
   note:{type:S.STRING(220)},
   occurred_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
  });
  await q.addIndex("provider_health_events",["provider_id","occurred_at"],{name:"idx_provider_health_events_date"});
 },
 async down(q){await q.dropTable("provider_health_events")}
};
