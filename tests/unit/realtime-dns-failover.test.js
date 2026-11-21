import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = relative => readFileSync(new URL(`../../src/${relative}`, import.meta.url), 'utf8');

test('avisos de DNS caído são agrupados por rede e não gravam milhares de comandos SQL', () => {
  const monitor = source('modules/provider-monitor/monitor.service.js');
  const notify = source('modules/provider-monitor/active-route.service.js');
  assert.match(monitor, /for \(const providerId of newlyDown\)/);
  assert.match(notify, /broadcastDeviceHint\(\{topic:'dns-failover',partnerId:provider\.partnerId,providerId\}\)/);
  assert.doesNotMatch(notify, /INSERT INTO device_remote_commands/);
  assert.match(monitor, /SELECT DISTINCT provider_id FROM device_provider_routes/);
});

test('WSS e HTTPS propagam metadado de DNS, nunca URL de origem nem credenciais', () => {
  const channel = source('realtime/device-channel.js');
  const bus = source('realtime/change-bus.js');
  assert.match(channel, /hint\.topic === 'dns-failover'/);
  assert.match(channel, /providerId: hint\.providerId/);
  assert.match(channel, /partnerId/);
  assert.match(bus, /msg\.topic !== 'dns-failover'/);
  assert.match(bus, /publishDeviceChange/);
  assert.doesNotMatch(channel.slice(channel.indexOf('function hintPacket'), channel.indexOf('function readHints')), /password|baseUrl|username/);
});

test('resolução inicial ignora pin antigo e usa o primeiro DNS saudável em ordem de latência', () => {
  const resolver = source('modules/provider-monitor/resolve.service.js');
  assert.match(resolver, /\.sort\(\(a,b\)=>/);
  assert.match(resolver, /const selected = ranked\[0\]/);
  assert.doesNotMatch(resolver, /const pinned =/);
  assert.match(resolver, /verifyAlternative\(candidate/);
  assert.match(resolver, /rememberSelectedProvider\(activation\.id/);
});

test('cliente recebe o identificador do DNS selecionado nos modos proxy e redirect', () => {
  const xtream = source('modules/xtream/xtream.service.js');
  assert.equal((xtream.match(/selectedProviderId:cred\.selectedProvider\?\.id/g)||[]).length, 2);
});
