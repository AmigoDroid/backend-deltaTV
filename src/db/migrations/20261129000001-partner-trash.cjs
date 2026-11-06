"use strict";
// Fotografia somente dos estados alterados pelo arquivamento. Não guarda senhas.
// Os arquivamentos anteriores à implantação não possuem fotografia: são restaurados bloqueados.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async (transaction) => {
      await q.createTable("partner_trash_snapshots", {
        partner_id: { type: S.UUID, primaryKey: true, references: { model: "partners", key: "id" }, onDelete: "CASCADE" },
        previous_status: { type: S.STRING(20), allowNull: false },
        previous_status_reason: { type: S.STRING(500) },
        users: { type: S.JSONB, allowNull: false, defaultValue: [] },
        codes: { type: S.JSONB, allowNull: false, defaultValue: [] },
        providers: { type: S.JSONB, allowNull: false, defaultValue: [] },
        web_accesses: { type: S.JSONB, allowNull: false, defaultValue: [] },
        archived_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      }, { transaction });
      await q.addIndex("partners", ["status", "updated_at"], { name: "ix_partners_trash", transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      const [rows] = await q.sequelize.query("SELECT count(*)::int AS n FROM partner_trash_snapshots", { transaction });
      if (Number(rows[0]?.n)) throw new Error("Reversão recusada: existem fotografias de cadastros arquivados que seriam perdidas.");
      await q.removeIndex("partners", "ix_partners_trash", { transaction });
      await q.dropTable("partner_trash_snapshots", { transaction });
    });
  },
};
