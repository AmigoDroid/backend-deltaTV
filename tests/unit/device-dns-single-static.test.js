import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('preferência individual tem prazo e chave de ativação; não altera pool por código',()=>{
  const migration=read('../../src/db/migrations/20270112000001-device-dns-override.cjs');
  const service=read('../../src/modules/provider-monitor/device-dns.service.js');
  const resolver=read('../../src/modules/provider-monitor/resolve.service.js');
  assert.match(migration,/activation_id:.*primaryKey:true/);
  assert.match(migration,/expires_at/);
  assert.match(service,/Activation\.findOne\(\{where:\{id:activationId,partnerId,status:'active'\}/);
  assert.match(service,/serversForCode\(code,\{bypassCache:true\}\)/);
  assert.match(service,/probeCredentials\(provider,credentials\)/);
  assert.doesNotMatch(service,/CodeServerPool\.(?:create|bulkCreate|destroy|update)/);
  assert.match(resolver,/FROM device_dns_overrides WHERE activation_id=:aid AND expires_at>now\(\)/);
  assert.match(resolver,/deviceForced\.id!==avoidId/);
  assert.match(resolver,/states\.get\(deviceForced\.id\)\?\.state!=='down'/);
  assert.ok(resolver.indexOf('const deviceForced=')<resolver.indexOf('const forced=servers.find'));
});
test('rotas individuais compartilham o isolamento e exigem permissão do portal',()=>{
  const routes=read('../../src/modules/provider-monitor/emergency.routes.js');
  const service=read('../../src/modules/provider-monitor/device-dns.service.js');
  assert.match(routes,/r\.post\('\/device\/:id',macWriteLimiter/);
  assert.match(routes,/r\.delete\('\/device\/:id',macWriteLimiter/);
  assert.match(routes,/await partnerOf\(req\)/);
  assert.match(service,/where:\{mac:canonical,partnerId,status:'active'\}/);
  assert.match(service,/WHERE d\.activation_id=a\.id AND a\.id=:aid AND a\.partner_id=:partnerId/);
});
test('aviso WSS somente à ativação, sem credenciais e com expiração',()=>{
  const service=read('../../src/modules/provider-monitor/device-dns.service.js');
  const wss=read('../../src/realtime/device-channel.js');
  const bus=read('../../src/realtime/change-bus.js');
  assert.match(service,/topic:'dns-device',activationId,partnerId/);
  assert.match(service,/topic:'dns-device-end',activationId,partnerId/);
  assert.match(wss,/if \(hint\.activationId && String\(hint\.activationId\) !== String\(activationId\)\)/);
  assert.match(bus,/activationId, partnerId/);
  assert.doesNotMatch(bus,/password:|baseUrl:/);
  assert.match(service,/notifyExpiredDeviceDns/);
});
