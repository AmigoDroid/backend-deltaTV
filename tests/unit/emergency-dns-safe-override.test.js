import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = path => readFileSync(new URL(`../../src/${path}`, import.meta.url),'utf8');
test('emergência preserva associações antigas e expira prioridade fora da pool', () => {
  const op=source('modules/provider-monitor/emergency.service.js');
  const resolver=source('modules/provider-monitor/resolve.service.js');
  const pool=source('modules/provider-monitor/code-pool.service.js');
  assert.doesNotMatch(op, /CodeServerPool\.destroy\(/);
  assert.match(op, /temporaryOnly\+\+/);
  assert.match(pool, /extraProviderId/);
  assert.match(pool, /partnerId:code\.partnerId,status:'active'/);
  assert.match(resolver, /extraProviderId:preferences\?\.codeProviderId/);
  assert.match(resolver, /verifyAlternative\(forced,credentials\.username,credentials\.password\)/);
});
test('servidor novo e prioridade pertencem à mesma transação',()=>{
  const svc=source('modules/provider-monitor/emergency.service.js');
  const provider=source('modules/providers/provider.service.js');
  assert.match(svc, /createProvider\(partnerId,[\s\S]*?,actor,\{transaction\}\)/);
  assert.match(provider,/transaction \? insert\(transaction\) : sequelize\.transaction\(insert\)/);
});
test('consulta de códigos possui paginação; limite de escrita é por lote',()=>{
  const svc=source('modules/provider-monitor/emergency.service.js');
  const routes=source('modules/provider-monitor/emergency.routes.js');
  assert.match(svc,/limit:pageSize,offset:\(page-1\)\*pageSize/);
  assert.match(routes,/page:z\.coerce\.number\(\)/);
});
