import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { messageScope, canonicalMessagePayload, uniqueDeviceIds } from '../../src/modules/tv-messages/message.policy.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('revenda só envia dentro do escopo da parceria autenticada', () => {
  assert.deepEqual(messageScope({role:'partner',partnerId:'partner-1'}), {partnerId:'partner-1'});
  assert.equal(messageScope({role:'partner'}), null);
  assert.equal(messageScope({role:'support'}), null);
});
test('admin tem escopo global e revenda não herda escopo global', () => {
  assert.deepEqual(messageScope({role:'superadmin'}),{partnerId:null});
  assert.deepEqual(messageScope({role:'admin'}),{partnerId:null});
});
test('repetição de seleção não muda hash idempotente', () => {
  const v = {audience:'selected', title:'Aviso',message:'Atenção',expiresInDays:3};
  assert.equal(canonicalMessagePayload({...v,deviceIds:['b','a','a']}),
    canonicalMessagePayload({...v,deviceIds:['a','b']}));
  assert.deepEqual(uniqueDeviceIds(['b','a','a']),['a','b']);
});
test('envios a todos ignoram seleção residual', () => {
  const v = {audience:'all',title:'Aviso',message:'Teste',expiresInDays:3};
  assert.equal(canonicalMessagePayload({...v,deviceIds:['id1']}),
    canonicalMessagePayload({...v,deviceIds:[]}));
});
test('API do painel exige token e valida prévia de destinatários', () => {
  const src = source('../../src/modules/tv-messages/panel.routes.js');
  assert.match(src,/router\.use\(authenticate\)/);
  assert.match(src,/router\.get\('\/recipients'/);
  assert.match(src,/router\.post\('\/preview'/);
  assert.match(src,/router\.post\('\/:id\/cancel'/);
});
test('API do dispositivo usa token de telemetria e não aceita ID de ativação na URL', () => {
  const src = source('../../src/modules/tv-messages/device.routes.js');
  assert.match(src,/requireTelemetry/);
  assert.match(src,/req\.device\.activation\.id/g);
});
test('mensagens permanecem atreladas à ativação e permissões do dono',()=>{
  const src = source('../../src/modules/tv-messages/message.service.js');
  assert.match(src,/a\.partner_id = :partnerId/);
  assert.match(src,/grant_license\.owner_partner_id = :partnerId/);
  assert.match(src,/d\.activation_id=:activationId/);
  assert.match(src,/d\.read_at IS NULL/);
  assert.match(src,/c\.cancelled_at IS NULL/);
});
test('não transmite corpo da mensagem pelo WebSocket',()=>{
  const src=source('../../src/modules/tv-messages/message.service.js');
  assert.match(src,/broadcastDeviceHint\(\{ topic: 'tv-messages', activationId/);
  assert.doesNotMatch(src,/broadcastDeviceHint\(\{[^}]*message:/);
});
