"use strict";
/** Simplified Player Web: numeric partnership code -> individually generated web credential. */
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async (transaction) => {
      await q.addColumn("content_partner_terms", "allow_web_issuance", { type:S.BOOLEAN, allowNull:false, defaultValue:false }, {transaction});
      await q.addColumn("partner_codes", "allow_web_issuance", { type:S.BOOLEAN, allowNull:false, defaultValue:false }, {transaction});
      await q.addColumn("web_accesses", "content_owner_partner_id", { type:S.UUID, references:{model:"partners",key:"id"}, allowNull:true, onDelete:"SET NULL" }, {transaction});
      await q.addColumn("web_accesses", "source_partner_code_id", { type:S.UUID, references:{model:"partner_codes",key:"id"}, allowNull:true, onDelete:"SET NULL" }, {transaction});
      await q.addColumn("web_accesses", "issuance_key", { type:S.UUID, allowNull:true }, {transaction});
      await q.sequelize.query("ALTER TABLE web_accesses DROP CONSTRAINT IF EXISTS web_accesses_status_check; ALTER TABLE web_accesses ADD CONSTRAINT web_accesses_status_check CHECK (status IN ('pending','active','blocked','revoked'))",{transaction});
      await q.sequelize.query("CREATE UNIQUE INDEX ux_web_access_issuer_request ON web_accesses(partner_id, issuance_key) WHERE issuance_key IS NOT NULL", {transaction});
      await q.addIndex("web_accesses", ["content_owner_partner_id", "created_at"], {name:"ix_web_access_content_owner",transaction});
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction)=>{
      const [rows]=await q.sequelize.query("SELECT count(*)::int AS n FROM web_accesses WHERE source_partner_code_id IS NOT NULL", {transaction});
      if(Number(rows[0]?.n))throw new Error("Existem acessos Player Web emitidos com esta estrutura; reversão recusada.");
      await q.sequelize.query("ALTER TABLE web_accesses DROP CONSTRAINT IF EXISTS web_accesses_status_check; ALTER TABLE web_accesses ADD CONSTRAINT web_accesses_status_check CHECK (status IN ('active','blocked','revoked'))",{transaction});
      await q.removeIndex("web_accesses","ix_web_access_content_owner",{transaction});
      await q.removeIndex("web_accesses","ux_web_access_issuer_request",{transaction});
      for(const col of ["issuance_key","source_partner_code_id","content_owner_partner_id"])await q.removeColumn("web_accesses",col,{transaction});
      await q.removeColumn("partner_codes","allow_web_issuance",{transaction});
      await q.removeColumn("content_partner_terms","allow_web_issuance",{transaction});
    });
  },
};
