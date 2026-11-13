"use strict";
/** Etapa 5: índices pequenos para expiração controlada; sem DELETE automático.
 * DROP/CREATE CONCURRENTLY exigem que não haja transação aberta.
 */
const indexes = [
  ['idx_delta_auth_expiration', 'auth_sessions'],
  ['idx_delta_device_session_expiration', 'device_sessions'],
  ['idx_delta_scoped_session_expiration', 'device_scoped_sessions'],
];
module.exports = {
  async up(q) {
    for (const [idx, table] of indexes) {
      const [rows] = await q.sequelize.query(`SELECT x.indisvalid AS valid FROM pg_class c
        JOIN pg_index x ON x.indexrelid=c.oid JOIN pg_namespace ns ON ns.oid=c.relnamespace
        WHERE ns.nspname=current_schema() AND c.relname=:idx`,{replacements:{idx}});
      if (rows?.[0]?.valid === false) await q.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`);
      await q.sequelize.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${idx} ON ${table} (expires_at)`);
    }
  },
  async down(q) {
    for (const [idx] of [...indexes].reverse()) await q.sequelize.query(`DROP INDEX CONCURRENTLY IF EXISTS ${idx}`);
  },
};
