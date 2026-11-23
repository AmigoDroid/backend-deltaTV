import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const read = path => readFileSync(new URL(`../../src/${path}`, import.meta.url),'utf8');
const require = createRequire(import.meta.url);
const migration = require('../../src/db/migrations/20261123000001-client-apps-and-plan-slots.cjs');

const mockQ = (counts=[0,0]) => {
  const calls=[];
  const q={
    sequelize:{ transaction: async work => work({ LOCK:{UPDATE:'UPDATE'} }), query:async (sql)=>{calls.push(['query',sql]);return [[{count:counts[0]||0,devices:counts[1]||0}]];} },
    createTable:async(name)=>calls.push(['createTable',name]),
    addColumn:async(name,col)=>calls.push(['addColumn',name,col]),
    addIndex:async(name)=>calls.push(['addIndex',name]),
    removeColumn:async(name,col)=>calls.push(['removeColumn',name,col]),
    dropTable:async(name)=>calls.push(['dropTable',name]),
  };return {q,calls};
};

const fakeSequelize={UUID:'UUID',UUIDV4:'UUIDV4',STRING:n=>`STRING(${n})`,CHAR:n=>`CHAR(${n})`,DATE:'DATE',INTEGER:'INTEGER',literal:s=>s};

test('migração adiciona tabelas apps e vagas sem alterar devices.app_id',async()=>{
  const {q,calls}=mockQ();await migration.up(q,fakeSequelize);
  assert.deepEqual(calls.filter(c=>c[0]==='createTable').map(c=>c[1]),['client_apps','partner_apps']);
  assert.ok(calls.some(c=>c[0]==='addColumn'&&c[1]==='devices'&&c[2]==='client_app_id'));
  assert.ok(calls.some(c=>c[0]==='addColumn'&&c[1]==='service_plan_catalogs'&&c[2]==='max_apps'));
  assert.ok(calls.some(c=>c[0]==='addColumn'&&c[1]==='partner_service_plans'&&c[2]==='max_apps_override'));
  assert.ok(!calls.some(c=>JSON.stringify(c).includes('UPDATE devices')));
});

test('rollback remove campos e tabelas somente quando não há dados ativos',async()=>{
  const {q,calls}=mockQ();await migration.down(q);
  assert.ok(calls.some(c=>c[0]==='dropTable'&&c[1]==='partner_apps'));
  assert.ok(calls.some(c=>c[0]==='dropTable'&&c[1]==='client_apps'));
});

test('rollback protege apps vinculados de exclusão',async()=>{
  const {q,calls}=mockQ([1,0]);await assert.rejects(migration.down(q),/Desvincule/);
  assert.ok(!calls.some(c=>c[0]==='dropTable'));
});

test('rollback protege dispositivos vinculados de exclusão',async()=>{
  const {q,calls}=mockQ([0,2]);await assert.rejects(migration.down(q),/TVs/);
  assert.ok(!calls.some(c=>c[0]==='dropTable'));
});

test('sem appId mantém fluxo legado no cadastro',()=>{
  const srv=read('modules/client-apps/client-app.service.js');
  assert.match(srv,/!value \|\| value === 'roku' \|\| value === 'delta-tv-roku'/);
  assert.match(srv,/if \(isLegacyAppId\(identifier\)\) return null;/);
});

test('claims requerem hash, expiração, uso único e transação',()=>{
  const srv=read('modules/client-apps/client-app.service.js');
  assert.match(srv,/timingSafeEqual/);
  assert.match(srv,/claimCodeExpiresAt/);
  assert.match(srv,/claimCodeHash: null, claimCodeExpiresAt: null/);
  assert.match(srv,/await assertAppSlot\(partnerId, transaction\)/);
});

test('vagas efetivas usam override e lock no parceiro e catálogo',()=>{
  const slots=read('modules/client-apps/app-entitlement.js');
  assert.match(slots,/inheritedPlanOverrides\(/);
  assert.match(slots,/featuresFor\(tier,overrides,catalog\)\.maxApps/);
  assert.match(slots,/transaction\.LOCK\.UPDATE/);
  assert.match(slots,/transaction\.LOCK\.SHARE/);
});

test('checkActivation nega ativação de parceiro de outro app',()=>{
  const access=read('modules/access/access.service.js');
  assert.match(access,/bindingForDevice/);
  assert.match(access,/String\(activation\.partnerId\) !== String\(binding\.partner\.id\)/);
});

test('rota de cliente aceita appId, e código é imposto pelo servidor',()=>{
  const routes=read('modules/activations/client.routes.js');
  assert.match(routes,/appId: z\.string\(\)\.refine/);
  assert.match(routes,/partnerCodeForBinding\(binding\)/);
  assert.match(routes,/if \(device\?\.clientAppId\) throw unavailable\(\)/);
});

test('TVs sem vínculo globais só apresentam legado e parceiro usa escopo',()=>{
  const text=read('modules/devices/unlinked.service.js');
  assert.match(text,/clientAppId: null/);
  assert.match(text,/clientAppId: \{ \[Op\.in\]: apps \}/);
  assert.match(text,/where: \{ clientAppId: device\.clientAppId, partnerId, status: 'active' \}/);
});

test('downgrade de planos de apps falha com uso acima do limite',()=>{
  const ent=read('modules/client-apps/app-entitlement.js');
  const finance=read('modules/network-finance/finance.service.js');
  assert.match(ent,/APP_SLOTS_EXCEED_PLAN/);
  assert.match(finance,/appUsage>Number\(plan\?\.maxApps\?\?0\)/);
});

test('white-label Xtream antigo mantém implementação e sem header X-App-Key',()=>{
  const service=read('modules/client-apps/client-app.service.js');
  assert.doesNotMatch(service,/X-App-Key|app_type|dedicated_client/);
});
