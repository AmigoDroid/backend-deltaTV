import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = relative => readFileSync(new URL(`../../src/${relative}`, import.meta.url), 'utf8');

test('sequencia do canal das TVs nao reinicia em 0 (evita reconnect em massa apos deploy)', () => {
  const src = source('realtime/device-channel.js');
  assert.match(src, /let sequence = Math\.floor\(Date\.now\(\) \/ 1000\)/);
  assert.doesNotMatch(src, /topic: 'reconnect', scope: 'targeted'/);
});

test('long-poll saturado responde 503 + Retry-After, nunca 200 vazio imediato', () => {
  const src = source('realtime/device-channel.js');
  assert.match(src, /waiting\.size >= MAX_PENDING_POLLS\) \{\s*res\.status\(503\)\.set\('Retry-After'/);
  assert.doesNotMatch(src, /hints\.length \|\| waiting\.size >= MAX_PENDING_POLLS/);
});

test('avisos globais iguais sao fundidos e edicao de parceiro nao acorda TVs de outros parceiros', () => {
  assert.match(source('realtime/device-channel.js'), /coalesced\(\{ topic: topicKey/);
  assert.match(source('app.js'), /broadcastDeviceHint\(\{ \.\.\.deviceChange, partnerId:/);
});

test('rotas /client usam limite por aparelho (token), nao por IP compartilhado', () => {
  assert.match(source('app.js'), /app\.use\("\/api\/v1\/client", clientLimiter, clientRoutes\)/);
  assert.match(source('middleware/security.js'), /export const clientLimiter/);
});
