import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertPackageInput, packageSnapshotFromRow } from '../../src/modules/service-packages/package.rules.js';
import { packageSnapshot } from '../../src/modules/partner-portal-sales/commercial-v2.rules.js';

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const sample = () => ({ code:'pacote_app', name:'Pacote com app', wholesaleCents:100,
  minResaleCents:100, maxDns:1, activationLimit:100, maxApps:1,
  autoFailover:true, autoPriority:false, emailAlerts:true, detailedHistory:false });

test('pacote aceita de 0 a 50 aplicativos próprios, sem permitir valor inválido', () => {
  for (const maxApps of [0,1,50]) assert.equal(assertPackageInput({...sample(),maxApps}).maxApps,maxApps);
  for (const maxApps of [-1,51,1.5]) assert.throws(() => assertPackageInput({...sample(),maxApps}),/Limite de apps próprios inválido/);
  assert.equal(assertPackageInput({...sample(),maxApps:undefined}).maxApps,undefined);
});

test('snapshot do pacote carrega a cota de apps, com padrão legado zero', () => {
  const row = {code:'pacote_app',name:'Pacote com app',service_tier:'pkg_pacote_app',revision:2,max_dns:1,activation_limit:100,max_apps:2};
  assert.equal(packageSnapshotFromRow(row).maxApps,2);
  assert.equal(packageSnapshotFromRow({...row,max_apps:undefined}).maxApps,0);
});

test('Admin configura os apps na tela real de Pacotes de Serviço e envia ao backend', () => {
  const ui = source('../../../admin/src/pages/ServicePackages.jsx');
  assert.match(ui,/Apps próprios incluídos/);
  assert.match(ui,/maxApps:Number\(p\.max_apps\?\?0\)/);
  assert.match(ui,/\{p\.max_apps\?\?0\} app\(s\) próprio\(s\)/);
  const routes = source('../../src/modules/service-packages/package.routes.js');
  assert.match(routes,/maxApps:z\.number\(\)\.int\(\)\.min\(0\)\.max\(50\)\.optional\(\)/);
});

test('pacote grava cota no catálogo técnico e a atribuição congela a cota do parceiro', () => {
  const catalog = source('../../src/modules/service-packages/package.service.js');
  assert.match(catalog,/max_apps=excluded\.max_apps/);
  assert.match(catalog,/maxApps=input\.maxApps\?\?Number\(technical\?\.max_apps\?\?0\)/);
  assert.match(catalog,/maxApps:Number\(current\.max_apps\?\?0\)/);
  assert.match(catalog,/assertNoSlotDowngrade\(row\.partner_id,maxApps,t\)/);
  const assign = source('../../src/modules/service-packages/package.apply.js');
  assert.match(assign,/max_apps_override=excluded\.max_apps_override/);
  assert.match(assign,/maxApps:snapshot\.maxApps\?\?null/);
  assert.match(assign,/assertNoSlotDowngrade\(partnerId,snapshot\.maxApps,transaction\)/);
});

test('cadastros e convites novos congelam a quantidade de apps no snapshot', () => {
  const plan = {code:'pacote_app',name:'Pacote com app',service_tier:'pkg_pacote_app',max_dns:1,activation_limit:100,max_apps:3};
  assert.equal(packageSnapshot(plan).maxApps,3);
  assert.equal(Object.hasOwn(packageSnapshot({...plan,max_apps:undefined}),'maxApps'),false);
  for (const path of ['commercial-v2.service.js','invitations.service.js','sales.service.js']) {
    const file = source(`../../src/modules/partner-portal-sales/${path}`);
    assert.match(file,/SELECT p\.\*,c\.max_apps FROM partner_portal_sales_plans/);
  }
});
