// Teste sem dependências externas: valida agrupar/ordenar milhares de eventos.
// Executar: node --experimental-vm-modules --test tests/performance/audit-batch.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function moduleWithFakeDatabase() {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, Date });
  const calls = [];
  const sequelize = {
    query: async (sql, opts = {}) => {
      if (String(sql).includes('jsonb_to_recordset')) {
        const batch = JSON.parse(opts.replacements.batch);
        const keys = batch.map(x => `${x.activation}:${x.source}`);
        assert.equal(new Set(keys).size, batch.length, 'uma chave por rodada PostgreSQL');
        assert.ok(batch.length <= 250, 'lote de no máximo 250 eventos');
        calls.push(batch);
      }
      return [];
    }
  };
  const mocks = {
    '../devices/presence.js': { touchDevice() {} },
    'node:net': { isIP: () => 0 },
    'node:crypto': { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    'sequelize': { QueryTypes: { SELECT: 'SELECT' } },
    '../../db/sequelize.js': { sequelize },
    '../../shared/errors.js': { notFound: msg => new Error(msg) }
  };
  const file = new URL('../../src/modules/connection-audit/service.js', import.meta.url);
  const mod = new vm.SourceTextModule(await readFile(file, 'utf8'), { context: ctx });
  await mod.link(async specifier => {
    const entries = Object.entries(mocks[specifier] || {});
    assert.ok(entries.length, `dependência simulada: ${specifier}`);
    return new vm.SyntheticModule(entries.map(([key]) => key), function () {
      for (const [key, value] of entries) this.setExport(key, value);
    }, { context: ctx });
  });
  await mod.evaluate();
  return { api: mod.namespace, calls };
}
const aid = i => `00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`;

test('3000 TVs: snapshots em lote, sem SQL individual nem perdas', async () => {
  const { api, calls } = await moduleWithFakeDatabase();
  for (let i = 0; i < 3000; i++) assert.ok(api.observe({ activationId: aid(i), source: 'tv', state: 'playing', position: 123 }));
  await api.flushAudit();
  assert.equal(calls.flat().length, 3000);
  assert.ok(calls.length <= 14, `consultas em lote: ${calls.length}`);
  assert.equal(api.auditQueueStats().queued, 0);
  assert.equal(api.auditQueueStats().dropped, 0);
});

test('mesma TV: transições rápidas são preservadas na ordem correta', async () => {
  const { api, calls } = await moduleWithFakeDatabase();
  for (const state of ['opening','playing','buffering','playing','error','stopped']) {
    api.observe({ activationId: aid(1), source: 'tv', state });
  }
  await api.flushAudit();
  assert.deepEqual(Array.from(calls.flat().map(x => x.state)),
    ['opening','playing','buffering','playing','error','stopped']);
});

test('URLs completas e senhas não são incluídas nos dados da auditoria', async () => {
  const { api, calls } = await moduleWithFakeDatabase();
  await api.record({ activationId: aid(5), source: 'tv', state: 'opening',
    origin: 'https://usuario:senha@servidor.example:8443/live/user/pass/1?token=privado' });
  assert.equal(calls[0][0].origin, 'https://servidor.example:8443');
});
