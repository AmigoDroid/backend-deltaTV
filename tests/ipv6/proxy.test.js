import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBindHost, resolveTrustProxy, proxyConfigurationWarnings } from '../../src/shared/proxy-config.js';

test('B2 IPv6: bind em ::1 permanece explícito e permite Nginx em loopback', () => {
  assert.equal(resolveBindHost('production', '::1'), '::1');
  assert.equal(resolveTrustProxy('', { isProd: true, bindHost: '::1' }), 'loopback');
});

test('B2 IPv6: IP de cliente exige proxy confiável também em IPv6', () => {
  assert.equal(resolveTrustProxy('0', { isProd: true, bindHost: '::1' }), 0);
  assert.ok(proxyConfigurationWarnings({ isProd: true, bindHost: '::1', trustProxy: 0 })
    .some(message => message.includes('TRUST_PROXY=0')));
});

test('B2 IPv6: não confiar irrestritamente nos cabeçalhos encaminhados', () => {
  assert.ok(proxyConfigurationWarnings({ isProd: true, bindHost: '::1', trustProxy: true })
    .some(message => message.includes('irrestrito')));
  assert.throws(() => resolveTrustProxy('::/0', { isProd: true, bindHost: '::1' }), /TRUST_PROXY inválido/);
});
