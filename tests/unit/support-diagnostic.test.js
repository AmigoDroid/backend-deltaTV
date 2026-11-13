import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSupport } from '../../src/modules/support/diagnostic.rules.js';

const allowed = { allowed: true, code: 'OK' };
test('licença expirada é crítica, mesmo que a TV esteja online', () => {
  const r = assessSupport({ access: { allowed: false, code: 'LICENSE_EXPIRED' }, connection: {online:true} });
  assert.equal(r.status, 'critical');
  assert.equal(r.findings[0].code, 'LICENSE_EXPIRED');
});
test('falha recente de servidor é atenção; nenhuma troca automática', () => {
  const r = assessSupport({ access: allowed, connection: { online: true }, provider: { state:'down', fresh:true } });
  assert.equal(r.status, 'warning');
  assert.equal(r.findings[0].code, 'PROVIDER_DOWN');
});
test('sondagem antiga não prova falha atual', () => {
  const r = assessSupport({ access: allowed, connection: { online:true }, provider: { state:'down', fresh:false } });
  assert.equal(r.status, 'ok');
});
test('sem presença não significa internet definitivamente quebrada', () => {
  const r = assessSupport({ access: allowed, connection: { online:false } });
  assert.equal(r.status,'unknown');
  assert.match(r.findings[0].evidence, /não comprova/i);
});
test('vencimento comercial não desliga licença', () => {
  const r = assessSupport({ access:allowed, connection:{online:true}, commercial:{daysLeft:-3} });
  assert.equal(r.status,'warning');
  assert.equal(r.findings[0].code,'COMMERCIAL_OVERDUE');
  assert.match(r.findings[0].evidence,/Não equivale a bloqueio/);
});
test('erro de reprodução precisa de telemetria atual', () => {
  const r = assessSupport({ access:allowed, connection:{online:true}, recentEvent:{state:'error',fresh:false} });
  assert.ok(!r.findings.some(f=>f.code==='RECENT_PLAYBACK_ERROR'));
});
test('buffering recente aparece na triagem', () => {
  const r = assessSupport({ access:allowed, connection:{online:true}, playback:{state:'buffering'} });
  assert.equal(r.findings[0].code,'PLAYER_BUFFERING');
});
test('falta de checagem não vira autorizado', () => {
  const r = assessSupport({ connection:{ online:true } });
  assert.equal(r.status,'unknown');
  assert.equal(r.findings[0].code,'ACCESS_NOT_CHECKED');
});
test('bloqueio tem prioridade sobre vencimento comercial', () => {
  const r = assessSupport({ access:{allowed:false,code:'DEVICE_BLOCKED'}, connection:{online:false}, commercial:{daysLeft:-2} });
  assert.equal(r.status,'critical');
  assert.equal(r.findings[0].code,'DEVICE_BLOCKED');
});
