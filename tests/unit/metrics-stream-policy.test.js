import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsStreamInterval } from '../../src/modules/system/metrics-stream-policy.js';

test('monitor ao vivo usa 500ms por padrão sem carregar o banco', () => {
  assert.equal(metricsStreamInterval(undefined), 500);
  assert.equal(metricsStreamInterval(''), 500);
  assert.equal(metricsStreamInterval('abc'), 500);
  assert.equal(metricsStreamInterval('Infinity'), 500);
});
test('limites seguros do intervalo para VPS pequena', () => {
  assert.equal(metricsStreamInterval('50'), 250);
  assert.equal(metricsStreamInterval('250'), 250);
  assert.equal(metricsStreamInterval('750'), 750);
  assert.equal(metricsStreamInterval('3000'), 2000);
  assert.equal(metricsStreamInterval('-5'), 500);
});
