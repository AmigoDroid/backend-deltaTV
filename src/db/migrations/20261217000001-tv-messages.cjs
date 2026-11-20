'use strict';
/**
 * This filename is tracked by SequelizeMeta (sequelize-cli). 20261212 created the
 * canonical schema already used by tv-messages/routes.js. Historical installs
 * may also have the alternative schema (normalized by 20261219).
 *
 * Never replace an existing table or mutate its columns: doing so can destroy
 * deliveries/constraints in a previously migrated installation.
 */
const MARKER = 'deltatv:owned-by-20261217000001-tv-messages';
const TABLES = ['tv_message_campaigns', 'tv_message_deliveries'];
const select = async (q, sql, transaction) => {
  const result = await q.sequelize.query(sql, {
    transaction,
    type: q.sequelize.QueryTypes?.SELECT || 'SELECT',
  });
  return Array.isArray(result?.[0]) && result.length === 2 && !Array.isArray(result[1]) ? result[0] : result;
};
const columns = async (q, table, t) => {
  const rows = await select(q, `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}'`, t);
  return new Set(Array.isArray(rows) ? rows.map(c => c.column_name) : []);
};
const execute = (q, sql, transaction) => q.sequelize.query(sql, { transaction });

module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      const existing = await columns(q, TABLES[0], transaction);
      if (existing.size && !existing.has('sender_id') && !existing.has('sender_user_id')) {
        throw new Error('TV_MESSAGES_SCHEMA_UNKNOWN: esquema de mensagens não reconhecido; nenhuma tabela foi modificada.');
      }
      // Preserve the alternative historical schema; the later 20261219 migration
      // handles its column renames. For a fresh standalone run, use canonical.
      const alternative = existing.has('sender_user_id') && !existing.has('sender_id');
      if (!existing.size) {
        await execute(q, `CREATE TABLE IF NOT EXISTS tv_message_campaigns (
          id uuid PRIMARY KEY, sender_id uuid NOT NULL, partner_id uuid,
          request_id uuid NOT NULL, payload_hash varchar(64) NOT NULL,
          title varchar(100) NOT NULL, message varchar(1200) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
          cancelled_at timestamptz, UNIQUE(sender_id,request_id));`, transaction);
        await execute(q, `COMMENT ON TABLE tv_message_campaigns IS '${MARKER}'`, transaction);
      }
      const deliveryColumns = await columns(q, TABLES[1], transaction);
      if (!deliveryColumns.size) {
        if (alternative) {
          await execute(q, `CREATE TABLE IF NOT EXISTS tv_message_deliveries (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            campaign_id uuid NOT NULL REFERENCES tv_message_campaigns(id) ON DELETE CASCADE,
            device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
            activation_id uuid REFERENCES activations(id) ON DELETE SET NULL,
            delivered_at timestamptz, read_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(campaign_id,device_id));`, transaction);
        } else {
          await execute(q, `CREATE TABLE IF NOT EXISTS tv_message_deliveries (
            campaign_id uuid NOT NULL REFERENCES tv_message_campaigns(id) ON DELETE CASCADE,
            device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            activation_id uuid NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
            read_at timestamptz, PRIMARY KEY(campaign_id,device_id));`, transaction);
        }
        await execute(q, `COMMENT ON TABLE tv_message_deliveries IS '${MARKER}'`, transaction);
      }
      // Only create missing indexes; old 20261212 indexes are already present.
      if (!alternative) {
        await execute(q, `CREATE INDEX IF NOT EXISTS tv_message_inbox_idx
          ON tv_message_deliveries(device_id,campaign_id) WHERE read_at IS NULL`, transaction);
        await execute(q, `CREATE INDEX IF NOT EXISTS tv_message_owner_idx
          ON tv_message_campaigns(partner_id,created_at DESC)`, transaction);
      }
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      // Roll back ONLY objects explicitly created by this migration, and never
      // drop message history. Existing installations from 20261212 are untouched.
      for (const table of [...TABLES].reverse()) {
        const [row] = await select(q,
          `SELECT obj_description(to_regclass('public.${table}'),'pg_class') AS owner`, transaction);
        if (row?.owner !== MARKER) continue;
        const [content] = await select(q, `SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS has_rows`, transaction);
        if (content?.has_rows) throw new Error(`TV_MESSAGES_DOWN_HAS_DATA: ${table}; rollback recusado para preservar mensagens.`);
        await execute(q, `DROP TABLE ${table}`, transaction);
      }
    });
  },
};
