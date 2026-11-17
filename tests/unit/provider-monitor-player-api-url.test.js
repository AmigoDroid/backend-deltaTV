import test from 'node:test';
import assert from 'node:assert/strict';
import { xtreamApiUrl, monitorProbeUrl } from '../../src/modules/provider-monitor/url-utils.js';
import { probeTargetKey } from '../../src/modules/provider-monitor/probe-dedup.js';

const cases = [
  ['https://dns.exemplo.com', 'https://dns.exemplo.com/player_api.php'],
  ['https://dns.exemplo.com/', 'https://dns.exemplo.com/player_api.php'],
  ['http://dns.exemplo.com:8080', 'http://dns.exemplo.com:8080/player_api.php'],
  ['https://dns.exemplo.com/xtream', 'https://dns.exemplo.com/xtream/player_api.php'],
  ['https://dns.exemplo.com/xtream/', 'https://dns.exemplo.com/xtream/player_api.php'],
  ['https://dns.exemplo.com/player_api.php', 'https://dns.exemplo.com/player_api.php'],
  ['https://dns.exemplo.com/player_api.php/', 'https://dns.exemplo.com/player_api.php'],
  ['https://dns.exemplo.com/xtream/player_api.php?username=x&password=y', 'https://dns.exemplo.com/xtream/player_api.php'],
  ['https://dns.exemplo.com/PLAYER_API.PHP', 'https://dns.exemplo.com/player_api.php'],
  ['https://dns.exemplo.com/xtream/?token=123#frag', 'https://dns.exemplo.com/xtream/player_api.php'],
];

test('resolvedor Xtream monta /player_api.php exatamente uma vez, preservando subpasta e porta', () => {
  for (const [input, expected] of cases) {
    assert.equal(xtreamApiUrl(input).href, expected, input);
  }
});

test('URL do resolvedor Xtream não transporta credenciais embutidas', () => {
  const url = xtreamApiUrl('https://usuario:segredo@dns.exemplo.com/base?username=alice&password=123');
  assert.equal(url.href, 'https://dns.exemplo.com/base/player_api.php');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
});

test('rejeita protocolo inválido', () => {
  assert.throws(() => xtreamApiUrl('file:///etc/passwd'), /Invalid scheme/);
});

const monitorCases = [
  ['https://dns.exemplo.com','https://dns.exemplo.com/'],
  ['http://dns.exemplo.com:8080','http://dns.exemplo.com:8080/'],
  ['https://dns.exemplo.com/subpasta','https://dns.exemplo.com/subpasta'],
  ['https://dns.exemplo.com/subpasta/','https://dns.exemplo.com/subpasta/'],
  ['https://dns.exemplo.com/xtream?token=123#fragmento','https://dns.exemplo.com/xtream'],
  ['https://dns.exemplo.com/player_api.php','https://dns.exemplo.com/player_api.php'],
];

test('sondagem consulta a URL do parceiro sem adicionar /player_api.php',()=>{
  for (const [input, expected] of monitorCases) {
    assert.equal(monitorProbeUrl(input).href, expected);
    assert.equal(probeTargetKey(input), expected);
  }
});

test('sondagem remove credenciais da URL (sem alterar o resolvedor Xtream)',()=>{
  const input='https://usuario:segredo@dns.exemplo.com/base?username=alice&password=123';
  assert.equal(monitorProbeUrl(input).href,'https://dns.exemplo.com/base');
  assert.equal(probeTargetKey(input),'https://dns.exemplo.com/base');
  assert.equal(xtreamApiUrl(input).href,'https://dns.exemplo.com/base/player_api.php');
});
