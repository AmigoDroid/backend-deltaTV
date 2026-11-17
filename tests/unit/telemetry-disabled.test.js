import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../src/', import.meta.url);
const read = path => readFileSync(new URL(path, root),'utf8');
test('auditoria desligada sem Map, DELETE/INSERT ou timer',()=>{
  const src=read('modules/connection-audit/service.js');
  assert.doesNotMatch(src,/new Map\s*\(|setInterval\s*\(|INSERT\s+INTO\s+device_connection|DELETE\s+FROM\s+device_connection/);
  assert.match(src,/storage:'disabled'/);
});
test('snapshot de playback desligado sem reter sessões',()=>{
  const src=read('realtime/live-snapshot.js');
  assert.doesNotMatch(src,/new Map\s*\(|setInterval\s*\(/);
  assert.match(src,/state:'unavailable'/);
});
test('servidor não inicializa tarefas de auditoria e agregação de telemetria',()=>{
  const src=read('server.js');
  assert.doesNotMatch(src,/startAudit\(\)|assessCollectiveQuality\(\)/);
});
test('presença e canal de controle continuam montados',()=>{
  const src=read('server.js');
  assert.match(src,/startPresence\(\)/);
  assert.match(src,/attachRealtime\(server\)/);
});
