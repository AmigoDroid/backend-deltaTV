import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const mp = load('../../src/modules/distribution/master-pix.service.js');
const commerce = load('../../src/modules/commerce/commerce.service.js');

// O Sequelize exige um delimitador reconhecível depois do nome de um replacement.
// Sem esse espaço, :status='' / :kind='master' / :state='active' pode
// atravessar a substituição e chegar ao PostgreSQL como token ":..." inválido.
test('Pix Master: a consulta de pedidos administra filtro de status sem placeholder colado ao =', () => {
  assert.match(mp, /WHERE \(:status\s+=\s+'' OR o\.status=:status\)/);
  assert.doesNotMatch(mp, /:status=/);
});

test('Commerce: listagem de planos substitui kind antes do operador', () => {
  assert.match(commerce, /owner_partner_id IS NULL AND :kind\s+=\s+'master'/);
  assert.doesNotMatch(commerce, /:kind=/);
});

test('Commerce: mudança de estado de assinatura respeita delimitador do replacement', () => {
  assert.match(commerce, /WHEN :state\s+=\s+'active' THEN/);
  assert.doesNotMatch(commerce, /:state=/);
});

test('Nenhuma substituição nomeada em SQL dos módulos alterados está grudada ao operador =', () => {
  for (const [name, src] of [['master-pix',mp],['commerce',commerce]]) {
    const candidates = [...src.matchAll(/`([\s\S]*?)`/g)].map(m => m[1]);
    for (const query of candidates) {
      if (!/\b(?:SELECT|UPDATE|INSERT|DELETE|WITH)\b/i.test(query)) continue;
      assert.doesNotMatch(query, /:[a-z][a-z0-9_]*=/ig, `${name}: query com replacement sem separação`);
    }
  }
});
