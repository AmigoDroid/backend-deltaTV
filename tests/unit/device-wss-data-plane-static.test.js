import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
test('operações das TVs modernas passam pelo socket autenticado e não por URL arbitrária', () => {
  const ws = read('../../src/realtime/device-channel.js');
  const actions = read('../../src/realtime/device-actions.service.js');
  assert.match(ws, /validDeviceAction\(msg\)/);
  assert.match(ws, /authorizeDevice\(msg\.token\)/);
  assert.match(actions, /assertDeviceToken\(peer, input\.accessToken\)/);
  assert.match(actions, /issueSiblingSession/);
  assert.match(actions, /listsOfDevice\(peer\.deviceId\)/);
  assert.match(actions, /type: 'route-result'/);
  assert.match(actions, /type: 'status-result'/);
  assert.match(actions, /type: 'remote-commands'/);
  assert.match(actions, /acknowledgeRemoteCommand/);
  assert.match(actions, /requestDeviceFailover/);
  assert.doesNotMatch(actions, /fetch\(input\.|axios\(input\.|new URL\(input\./);
});
test('chaves BrightScript em minúsculas são normalizadas; TV 65 continua recebendo avisos legados', () => {
  const ws = read('../../src/realtime/device-channel.js');
  const actions = read('../../src/realtime/device-actions.service.js');
  assert.match(actions, /input\.knownids/);
  assert.match(actions, /input\.accesstoken/);
  assert.match(actions, /input\.targetactivationid/);
  assert.match(ws, /Number\(peer\.build\) >= 66/);
  assert.match(ws, /type: 'command-ready'/);
});
