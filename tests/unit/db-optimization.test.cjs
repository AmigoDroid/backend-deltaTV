'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('../../src/db/migrations/20261210000001-query-performance-indexes.cjs');

function fakeQueryInterface({ invalid = [] } = {}) {
  const calls = [];
  return {
    calls,
    sequelize: {
      async query(sql, options = {}) {
        calls.push({ sql, options });
        if (/SELECT i\.indisvalid/.test(sql)) {
          const name = options.replacements.name;
          return [invalid.includes(name) ? [{ valid: false }] : [], null];
        }
        return [[], null];
      },
    },
  };
}

test('migration cria apenas 3 indices concorrentes, sem tocar em dados', async () => {
  const q = fakeQueryInterface();
  await migration.up(q);
  const ddl = q.calls.map(x => x.sql).filter(x => /CREATE INDEX/.test(x));
  assert.equal(ddl.length, 3);
  for (const sql of ddl) assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(ddl.join('\n'), /invoices \(partner_id, due_date\)/);
  assert.match(ddl.join('\n'), /activations \(partner_id, mac, activated_at DESC\)/);
  assert.match(ddl.join('\n'), /device_connection_events \(created_at DESC, activation_id\)/);
  assert.doesNotMatch(q.calls.map(x => x.sql).join('\n'), /\b(?:DELETE|TRUNCATE|DROP TABLE|ALTER TABLE|UPDATE)\b/);
});

test('migration repara indice invalido de tentativa anterior', async () => {
  const q = fakeQueryInterface({ invalid: ['idx_delta_tv_events_recent'] });
  await migration.up(q);
  const dropped = q.calls.map(x => x.sql).filter(x => /DROP INDEX/.test(x));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /DROP INDEX CONCURRENTLY IF EXISTS idx_delta_tv_events_recent/);
});

test('rollback remove apenas indices desta migration', async () => {
  const q = fakeQueryInterface();
  await migration.down(q);
  assert.equal(q.calls.length, 3);
  for (const { sql } of q.calls) assert.match(sql, /^DROP INDEX CONCURRENTLY IF EXISTS/);
});

test('consulta de disponibilidade agrega por servidor no banco', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../src/modules/provider-monitor/availability.service.js'), 'utf8');
  assert.match(code, /GROUP BY provider_id/);
  assert.match(code, /FILTER \(WHERE bucket >= CAST\(:since24h AS timestamptz\)\)/);
  assert.match(code, /slowSamples/);
  assert.match(code, /percent\(ok, samples\)/);
});

test('consulta de qualidade agrega eventos por ativacao antes do join', () => {
  const code = fs.readFileSync(path.join(__dirname, '../../src/modules/provider-monitor/quality.service.js'), 'utf8');
  assert.match(code, /tv_events AS \(/);
  assert.match(code, /GROUP BY activation_id/);
  assert.match(code, /provider_totals AS \(/);
  assert.doesNotMatch(code.slice(code.indexOf('const STATS_SQL'), code.indexOf('export async function providerQuality')), /count\(DISTINCT/);
});
