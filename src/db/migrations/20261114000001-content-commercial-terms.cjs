"use strict";
// Mantém os contratos antigos como 'legacy': migração nunca corta acesso de clientes existentes.
module.exports = {
  async up(q, S) {
    return q.sequelize.transaction(async transaction => {
    await q.createTable("content_partner_terms", {
      partner_id: { type:S.UUID,primaryKey:true,references:{model:"partners",key:"id"},onDelete:"RESTRICT" },
      mode: {type:S.STRING(24),allowNull:false,defaultValue:"legacy"},
      fixed_fee_cents: {type:S.INTEGER,allowNull:false,defaultValue:0},
      activation_limit: {type:S.INTEGER},
      license_policy: {type:S.STRING(20),allowNull:false,defaultValue:"standard"},
      credits_per_activation: {type:S.INTEGER,allowNull:false,defaultValue:1},
      auto_priority: {type:S.BOOLEAN,allowNull:false,defaultValue:true},
      created_at: {type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
      updated_at: {type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
    },{transaction});
    await q.sequelize.query(`ALTER TABLE content_partner_terms ADD CONSTRAINT chk_content_terms_mode CHECK (mode IN ('legacy','credits','fixed_unlimited','fixed_limited'));
      ALTER TABLE content_partner_terms ADD CONSTRAINT chk_content_terms_policy CHECK (license_policy IN ('standard','partner_only'));
      ALTER TABLE content_partner_terms ADD CONSTRAINT chk_content_terms_nonnegative CHECK (fixed_fee_cents >= 0 AND credits_per_activation BETWEEN 1 AND 100 AND (activation_limit IS NULL OR activation_limit >= 0));`,{transaction});
    await q.createTable("content_code_balances", {
      code_id: {type:S.UUID,primaryKey:true,references:{model:"partner_codes",key:"id"},onDelete:"RESTRICT"},
      allocated: {type:S.INTEGER,allowNull:false,defaultValue:0},
      spent: {type:S.INTEGER,allowNull:false,defaultValue:0},
      created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
      updated_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
    },{transaction});
    await q.sequelize.query(`ALTER TABLE content_code_balances ADD CONSTRAINT chk_code_credit_balances CHECK (allocated >= 0 AND spent >= 0 AND spent <= allocated)`,{transaction});
    await q.createTable("content_activation_charges", {
      id: {type:S.UUID,primaryKey:true,defaultValue:S.literal("gen_random_uuid()")},
      activation_id: {type:S.UUID,allowNull:false,references:{model:"activations",key:"id"},onDelete:"RESTRICT"},
      code_id: {type:S.UUID,allowNull:false,references:{model:"partner_codes",key:"id"},onDelete:"RESTRICT"},
      credits: {type:S.INTEGER,allowNull:false},
      created_at:{type:S.DATE,allowNull:false,defaultValue:S.fn("NOW")},
    },{transaction});
    await q.addConstraint("content_activation_charges",{type:"unique",fields:["activation_id","code_id"],name:"ux_content_charge_activation_code",transaction});
    await q.addIndex("content_activation_charges",["code_id","created_at"],{transaction});
    });
  },
  async down(q) {
    const [charges]=await q.sequelize.query("SELECT count(*)::int AS n FROM content_activation_charges");
    const [wallets]=await q.sequelize.query("SELECT count(*)::int AS n FROM content_code_balances WHERE allocated > 0 OR spent > 0");
    if (charges[0].n || wallets[0].n) throw new Error("Reversão recusada: existe histórico de consumo ou saldo alocado. Preserve os dados.");
    await q.dropTable("content_activation_charges");await q.dropTable("content_code_balances");await q.dropTable("content_partner_terms");
  },
};
