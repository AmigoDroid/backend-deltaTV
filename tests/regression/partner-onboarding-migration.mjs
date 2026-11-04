// Run: node --test tests/regression/partner-onboarding-migration.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Sequelize from 'sequelize';
import migration from '../../src/db/migrations/20261122000001-partner-onboarding-configured.cjs';

test('migration backfills only successful administrative configuration after completion and rolls back cleanly', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE partner_pre_registrations(id text, status text, completed_partner_id uuid, completed_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE audit_logs(entity_type text, entity_id text, actor_type text, result text, action text, created_at timestamptz);
      INSERT INTO partner_pre_registrations(id,status,completed_partner_id,completed_at) VALUES
      ('configured','completed','11111111-1111-4111-8111-111111111111','2026-11-01'),
      ('pending','completed','22222222-2222-4222-8222-222222222222','2026-11-01'),
      ('cancelled','cancelled','33333333-3333-4333-8333-333333333333','2026-11-01');
      INSERT INTO audit_logs VALUES
      ('partner','11111111-1111-4111-8111-111111111111','admin','success','content.terms.update','2026-11-02'),
      ('partner','22222222-2222-4222-8222-222222222222','admin','success','partner.update','2026-10-31'),
      ('partner','22222222-2222-4222-8222-222222222222','admin','failure','partner.update','2026-11-02'),
      ('partner','33333333-3333-4333-8333-333333333333','admin','success','partner.update','2026-11-02');`);
    const qi = {
      sequelize: { transaction: callback => db.transaction(t => callback(t)), query: (sql, { transaction }) => transaction.exec(sql) },
      addColumn: (table, column, _type, { transaction }) => transaction.exec(`ALTER TABLE ${table} ADD COLUMN ${column} timestamptz`),
      addIndex: (table, columns, { name, transaction }) => transaction.exec(`CREATE INDEX ${name} ON ${table} (${columns.join(',')})`),
      removeIndex: (_table, name, { transaction }) => transaction.exec(`DROP INDEX ${name}`),
      removeColumn: (table, column, { transaction }) => transaction.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`),
    };
    await migration.up(qi, Sequelize);
    const { rows } = await db.query('SELECT id, configured_at FROM partner_pre_registrations ORDER BY id');
    assert.equal(rows.find(row => row.id === 'configured').configured_at.toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(rows.find(row => row.id === 'pending').configured_at, null);
    assert.equal(rows.find(row => row.id === 'cancelled').configured_at, null);
    await migration.down(qi);
    const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='partner_pre_registrations' AND column_name='configured_at'");
    assert.equal(columns.rows.length, 0);
  } finally { await db.close(); }
});
