import test from 'node:test';
import assert from 'node:assert/strict';
import { xtreamApiUrl } from '../../src/modules/provider-monitor/url-utils.js';
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

test('sondagem monta /player_api.php exatamente uma vez, preservando subpasta e porta', () => {
  for (const [input, expected] of cases) {
    assert.equal(xtreamApiUrl(input).href, expected, input);
    assert.equal(probeTargetKey(input), expected, input);
  }
});

test('a URL de sondagem não transporta credenciais', () => {
  const url = xtreamApiUrl('https://usuario:segredo@dns.exemplo.com/base?username=alice&password=123');
  assert.equal(url.href, 'https://dns.exemplo.com/base/player_api.php');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.search, '');
});

test('rejeita protocolo inválido', () => {
  assert.throws(() => xtreamApiUrl('file:///etc/passwd'), /Invalid scheme/);
});
