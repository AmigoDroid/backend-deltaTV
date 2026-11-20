import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const content = p => readFileSync(new URL(`../../src/${p}`,import.meta.url), 'utf8');
test('conexão atual não persiste auditoria no Postgres nem executa limpeza de histórico', () => {
  const service=content('modules/connection-audit/service.js');
  assert.doesNotMatch(service, /INSERT INTO device_connection_|DELETE FROM device_connection_|setInterval\(\(\) => \{ void cleanupAudit/);
  assert.doesNotMatch(service,/const snapshots = new Map\(\)|MAX_SNAPSHOTS = 30000/);
  assert.match(service,/storage:'disabled'/);
});
test('qualidade e failover não consultam tabelas removidas', () => {
  const quality=content('modules/provider-monitor/quality.service.js');
  const failover=content('modules/provider-monitor/device-failover.service.js');
  const support=content('modules/support/support.service.js');
  for (const src of [quality, failover, support]) assert.doesNotMatch(src, /FROM device_connection_(events|latest)/);
});
test('migração elimina as duas tabelas de auditoria persistente', () => {
  const migration=content('db/migrations/20270104000001-remove-persistent-device-connection-audit.cjs');
  assert.match(migration,/dropTable\('device_connection_events'/);
  assert.match(migration,/dropTable\('device_connection_latest'/);
});
