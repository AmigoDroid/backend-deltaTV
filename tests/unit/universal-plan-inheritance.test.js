import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuresFor, inheritedPlanOverrides } from '../../src/modules/service-plans/plan.rules.js';
import { effectivePackageQuota } from '../../src/modules/service-packages/package.inheritance.js';

const snapshot = {tier:'pkg_teste',maxApps:0,maxDns:2,autoFailover:false,
  autoPriority:false,emailAlerts:false,detailedHistory:false};
const catalog = {name:'Teste',maxApps:1,maxServers:5,autoFailover:true,
  autoPriority:true,emailAlerts:true,detailedHistory:true};
const previouslyCopied = {tier:'pkg_teste',maxAppsOverride:0,maxServersOverride:2,
  autoFailoverOverride:false,autoPriorityOverride:false,emailAlertsOverride:false,detailedHistoryOverride:false};

test('plano universal: copias do snapshot antigo herdam todas as capacidades atuais', () => {
  const inherited=inheritedPlanOverrides(previouslyCopied,snapshot);
  assert.equal(inherited.maxAppsOverride,null);
  assert.equal(inherited.maxServersOverride,null);
  const features=featuresFor(previouslyCopied.tier,inherited,catalog);
  assert.deepEqual({maxApps:features.maxApps,maxServers:features.maxServers,
    autoFailover:features.autoFailover,autoPriority:features.autoPriority,
    emailAlerts:features.emailAlerts,detailedHistory:features.detailedHistory},
    {maxApps:1,maxServers:5,autoFailover:true,autoPriority:true,emailAlerts:true,detailedHistory:true});
});

test('excecoes individuais antigas diferentes do snapshot permanecem', () => {
  const individual={...previouslyCopied,maxAppsOverride:3,maxServersOverride:4,autoFailoverOverride:true};
  const effective=inheritedPlanOverrides(individual,snapshot);
  assert.equal(effective.maxAppsOverride,3);
  assert.equal(effective.maxServersOverride,4);
  assert.equal(effective.autoFailoverOverride,true);
  assert.equal(featuresFor(individual.tier,effective,catalog).maxApps,3);
});

test('excecao nova de zero fica explicita mesmo quando coincide com snapshot historico', () => {
  const inherited=inheritedPlanOverrides(previouslyCopied,snapshot,
    {maxAppsOverride:true,autoFailoverOverride:true});
  assert.equal(featuresFor('pkg_teste',inherited,catalog).maxApps,0);
  assert.equal(featuresFor('pkg_teste',inherited,catalog).autoFailover,false);
});

test('snapshot de outro plano ou ausente nunca altera excecao', () => {
  assert.equal(inheritedPlanOverrides({...previouslyCopied,tier:'outro'},snapshot).maxAppsOverride,0);
  assert.equal(inheritedPlanOverrides(previouslyCopied,null).maxAppsOverride,0);
});

test('reducoes do pacote respeitam o valor efetivo, nao o override copiado', () => {
  const applied={package_code:'pacote',package_snapshot:snapshot,
    max_apps_override:0,max_servers_override:2,mode:'legacy',activation_limit:null};
  const reduced=effectivePackageQuota(applied,{max_apps:1,max_servers:5},
    {maxApps:0,maxDns:3,activationLimit:null});
  assert.equal(reduced.oldApps,1);
  assert.equal(reduced.maxApps,0);
  assert.equal(reduced.oldDns,5);
  assert.equal(reduced.maxDns,3);
});

test('as duas consultas e a exibicao comercial usam a mesma politica', () => {
  const source=(name)=>readFileSync(new URL(`../../src/modules/${name}`,import.meta.url),'utf8');
  assert.match(source('service-plans/plan.service.js'),/inheritedPlanOverrides\(record\|\|\{tier\},row.packageSnapshot,row.explicitOverrides\)/);
  assert.match(source('client-apps/app-entitlement.js'),/inheritedPlanOverrides\(\{tier,maxAppsOverride:assigned\?\.maxAppsOverride\}/);
  assert.match(source('network-finance/pricing.service.js'),/\.\.\.technical.features/);
  assert.match(source('service-packages/package.service.js'),/COALESCE\(live_snapshot->'explicitOverrides'/);
});
