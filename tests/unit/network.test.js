import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkCounters, defaultRouteInterfaces, createNetworkSampler } from '../../src/modules/system/network.js';
const dev = (name, rx, tx, errors = 0) => `${name}: ${rx} 1 ${errors} 2 0 0 0 0 ${tx} 2 3 4 0 0 0 0`;
const route = name => `${name} 00000000 0100000A 0003 0 0 100 00000000 0 0 0`;
function fixture() {
  let time = 0, config = '', capacity = '', fail = false;
  const files = { '/proc/net/dev': [dev('lo', 9000, 9000), dev('ens3', 1000, 2000), dev('docker0', 100000, 100000)].join('\n'), '/proc/net/route': route('ens3'), '/proc/net/ipv6_route': '' };
  return { files, setTime: t => time = t, configure: value => config = value, setCapacity: value => capacity = value, fail: value => fail = value,
    read: createNetworkSampler({ readFile: file => { if (fail) throw Error('unavailable'); return files[file] ?? ''; }, now: () => time, configuredInterfaces: () => config, capacityMbps: () => capacity }) };
}
test('network parser ignores headers/malformed counters and preserves errors/drops', () => {
  const rows = parseNetworkCounters('Inter-| Receive | Transmit\n' + dev('ens3', 123, 456, 7) + '\nbad: NaN 2 3\n');
  assert.equal(rows.size, 1); assert.equal(rows.get('ens3').receivedBytes, 123); assert.equal(rows.get('ens3').sentBytes, 456); assert.equal(rows.get('ens3').receiveErrors, 7); assert.equal(rows.get('ens3').sendDrops, 4);
});
test('default route discovery deduplicates IPv4 and IPv6 and ignores down routes', () => {
  assert.deepEqual(defaultRouteInterfaces(route('ens3') + '\nens9 00000000 00000000 0000 0 0 0 00000000', '00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 00000064 00000000 00000000 00000001 ens3'), ['ens3']);
});
test('first sample has totals but never invents a zero transfer rate', () => {
  const f = fixture(), sample = f.read(); assert.equal(sample.available, true); assert.equal(sample.receiveBytesPerSecond, null); assert.equal(sample.sentBytes, 2000); assert.deepEqual(sample.selectedInterfaces, ['ens3']); assert.equal(sample.selection, 'default-route');
});
test('rates use real elapsed monotonic time and exclude loopback/docker from totals', () => {
  const f = fixture(); f.read(); f.setTime(5000); f.files['/proc/net/dev'] = [dev('lo', 1000000, 1000000), dev('ens3', 5001000, 10002000), dev('docker0', 9000000, 9000000)].join('\n');
  const sample = f.read(); assert.equal(sample.receiveBytesPerSecond, 1000000); assert.equal(sample.sendBytesPerSecond, 2000000); assert.equal(sample.receivedBytes, 5001000); assert.equal(sample.intervalSeconds, 5);
});
test('counter resets do not create negative rates or bandwidth spikes', () => {
  const f = fixture(); f.read(); f.setTime(5000); f.files['/proc/net/dev'] = dev('ens3', 100, 200);
  const sample = f.read(); assert.equal(sample.receiveBytesPerSecond, null); assert.equal(sample.interfaces[0].counterReset, true);
  f.setTime(10000); f.files['/proc/net/dev'] = dev('ens3', 600, 700); assert.equal(f.read().sendBytesPerSecond, 100);
});
test('long gaps start a new baseline rather than showing a stale average as current', () => {
  const f = fixture(); f.read(); f.setTime(60000); assert.equal(f.read().sendBytesPerSecond, null); f.setTime(65000); assert.equal(f.read().sendBytesPerSecond, 0);
});
test('configured multi-interface totals and invalid configuration are explicit', () => {
  const f = fixture(); f.configure('ens3,ens4,ens3'); f.files['/proc/net/dev'] += '\n' + dev('ens4', 3000, 4000);
  const sample = f.read(); assert.equal(sample.selection, 'configured'); assert.equal(sample.receivedBytes, 4000); assert.equal(sample.sentBytes, 6000); assert.equal(sample.interfaces.filter(row => row.included).length, 2);
  f.configure('missing'); const missing = f.read(); assert.equal(missing.available, false); assert.deepEqual(missing.missingInterfaces, ['missing']);
});
test('automatic fallback ignores virtual paths to avoid counting traffic twice', () => {
  const f = fixture(); f.files['/proc/net/route'] = ''; assert.deepEqual(f.read().selectedInterfaces, ['ens3']);
});
test('failed reads recover without a spurious rate and capacity is optional', () => {
  const f = fixture(); f.read(); f.fail(true); assert.equal(f.read().available, false); f.fail(false); f.setTime(5000); f.setCapacity('1000'); const sample = f.read(); assert.equal(sample.receiveBytesPerSecond, null); assert.equal(sample.capacityMbps, 1000); f.setCapacity('garbage'); assert.equal(f.read().capacityMbps, null);
});
