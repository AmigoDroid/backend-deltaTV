"use strict";
module.exports = {
  async up(q, S) {
    await q.createTable("code_server_pools", {
      id: { type: S.UUID, primaryKey: true, allowNull: false, defaultValue: S.literal("gen_random_uuid()") },
      code_id: { type: S.UUID, allowNull: false, references: {model:"partner_codes", key:"id"}, onDelete:"CASCADE" },
      provider_id: { type: S.UUID, allowNull: false, references: {model:"partner_providers", key:"id"}, onDelete:"RESTRICT" },
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.fn("NOW") },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: S.fn("NOW") },
    });
    await q.addConstraint("code_server_pools", { fields:["code_id","provider_id"], type:"unique", name:"code_server_pools_unique" });
    await q.addIndex("code_server_pools",["provider_id"]);
  },
  async down(q) { await q.dropTable("code_server_pools"); }
};
