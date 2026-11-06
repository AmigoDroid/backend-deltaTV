"use strict";
module.exports = {
  async up(q, S) {
    // Esquema + carga legada atômicos: falhas não deixam a tabela criada sem
    // o registro da migration, o que impediria um novo db:migrate.
    await q.sequelize.transaction(async (transaction) => {
    // Pode existir parcialmente se a migration antiga falhou após o CREATE TABLE.
    const existing = await q.describeTable("pix_refund_cases", { transaction }).catch(() => null);
    if (!existing) await q.createTable("pix_refund_cases", {
      id: { type: S.UUID, allowNull: false, primaryKey: true, defaultValue: S.UUIDV4 },
      charge_id: { type: S.UUID, allowNull: false, unique: true, references: { model: "pix_charges", key: "id" } },
      amount_cents: { type: S.INTEGER, allowNull: false },
      status: { type: S.STRING(24), allowNull: false, defaultValue: "pending" },
      decision: { type: S.STRING(32) },
      notes: { type: S.TEXT },
      resolved_at: { type: S.DATE },
      resolved_by: { type: S.UUID },
      created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
      updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") },
    }, { transaction });
    await q.sequelize.query("CREATE INDEX IF NOT EXISTS pix_refund_cases_status_idx ON pix_refund_cases (status)", { transaction });
    // Pré-cadastro idempotente das devoluções legadas ainda não compensadas.
    // A migração não debita saldos nem cancela licenças.
    await q.sequelize.query(`INSERT INTO pix_refund_cases
      (id, charge_id, amount_cents, status, notes, created_at, updated_at)
      SELECT md5('deltatv-pix-refund:' || id::text)::uuid, id, amount_cents, 'pending',
        'Pendência anterior à implantação; verificar benefício e histórico antes de resolver.', now(), now()
      FROM pix_charges WHERE status = 'refunded'
        AND COALESCE(error, '') NOT IN
        ('Devolução conciliada e compensada.', 'Devolução conciliada: licença exclusiva cancelada por decisão administrativa.')
      ON CONFLICT (charge_id) DO NOTHING`, { transaction });
    });
  },
  async down(q) { await q.dropTable("pix_refund_cases"); },
};
