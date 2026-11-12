'use strict';
/**
 * Build 63: indices para consultas efetivamente utilizadas pela API.
 *
 * Requer PostgreSQL. `CONCURRENTLY` NAO pode estar dentro de uma transacao.
 * O Sequelize CLI deste projeto nao abre transacao implicitamente para migrations.
 * Preserva dados, regras de negocio e identidades existentes.
 *
 * Os indices sao poucos por escolha: cada indice aumenta custo de escrita e uso de SSD.
 */
const indexes = [
  {
    name: 'idx_delta_invoice_partner_due_open',
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delta_invoice_partner_due_open
      ON invoices (partner_id, due_date)
      WHERE status IN ('open', 'partial', 'overdue')`,
  },
  {
    name: 'idx_delta_activation_partner_live_mac',
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delta_activation_partner_live_mac
      ON activations (partner_id, mac, activated_at DESC)
      WHERE status <> 'revoked' AND mac IS NOT NULL`,
  },
  {
    name: 'idx_delta_tv_events_recent',
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delta_tv_events_recent
      ON device_connection_events (created_at DESC, activation_id)
      WHERE source = 'tv'`,
  },
];

/** Um indice invalido pode sobrar se um CREATE INDEX CONCURRENTLY foi interrompido. */
async function createOrRepairIndex(q, item) {
  const [rows] = await q.sequelize.query(`
    SELECT i.indisvalid AS valid
      FROM pg_class cls
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      JOIN pg_index i ON i.indexrelid = cls.oid
     WHERE ns.nspname = current_schema() AND cls.relname = :name`,
    { replacements: { name: item.name } });
  if (rows?.[0] && rows[0].valid === false) {
    // O indice invalido nao auxilia consultas e ainda pode receber atualizacoes.
    await q.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${item.name}`);
  }
  await q.sequelize.query(item.ddl);
}

module.exports = {
  async up(q) {
    // Nao envolver em q.sequelize.transaction: CONCURRENTLY exige autocommit.
    for (const item of indexes) await createOrRepairIndex(q, item);
  },
  async down(q) {
    // O rollback remove apenas os indices deste pacote, nunca tabelas ou linhas.
    for (const item of [...indexes].reverse()) {
      await q.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${item.name}`);
    }
  },
};
