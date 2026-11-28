import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {contractInheritsLimit,effectivePackageQuota,isReduction} from '../../src/modules/service-packages/package.inheritance.js';

const sample=()=>({partner_id:'a',package_code:'pacote_a',max_apps_override:null,max_servers_override:null,
  mode:'fixed_limited',activation_limit:10,auto_priority:false,
  live_snapshot:{maxApps:1,maxDns:2,activationLimit:10,autoPriority:false}});
const catalog={max_apps:1,max_servers:2};
const revised={maxApps:3,maxDns:5,activationLimit:25};

test('aumentar pacote atualiza apps, DNS e ativações herdadas',()=>{
  const old=sample();
  assert.equal(contractInheritsLimit(old),true);
  assert.deepEqual(effectivePackageQuota(old,catalog,revised),{
    oldApps:1,maxApps:3,oldDns:2,maxDns:5,oldActivation:10,activationLimit:25});
});
test('overrides negociados não são substituídos pela edição',()=>{
  const old={...sample(),max_apps_override:7,max_servers_override:8,activation_limit:12};
  assert.equal(contractInheritsLimit(old),false);
  const result=effectivePackageQuota(old,catalog,revised);
  assert.equal(result.maxApps,7);
  assert.equal(result.maxDns,8);
  assert.equal(result.activationLimit,12);
});
test('sem limite é diferente de zero; downgrade só quando existe redução',()=>{
  assert.equal(isReduction(null,1),true);
  assert.equal(isReduction(1,null),false);
  assert.equal(isReduction(3,1),true);
  assert.equal(isReduction(1,3),false);
  const old={...sample(),max_servers_override:0,mode:'fixed_unlimited',activation_limit:null,
    live_snapshot:{maxApps:0,maxDns:null,activationLimit:null,autoPriority:false}};
  const next=effectivePackageQuota(old,{max_apps:0,max_servers:null},revised);
  assert.equal(next.maxDns,null);
  assert.equal(next.activationLimit,25);
});
test('snapshot antigo não vira exceção só porque mudou o catálogo',()=>{
  const old={...sample(),package_snapshot:{maxApps:1,maxDns:2,activationLimit:10,autoPriority:false},live_snapshot:undefined};
  assert.equal(effectivePackageQuota(old,catalog,revised).maxApps,3);
  assert.equal(contractInheritsLimit(old),true);
});
test('migração preserva histórico e possui rollback',()=>{
 const sql=readFileSync(new URL('../../src/db/migrations/20270115000001-live-service-package-inheritance.cjs',import.meta.url),'utf8');
 assert.match(sql,/ADD COLUMN live_snapshot jsonb/);
 assert.match(sql,/package_snapshot/);
 assert.match(sql,/max_apps_override=CASE/);
 assert.match(sql,/CREATE TABLE service_package_inheritance_backup_/);
 assert.match(sql,/async down\(q\)/);
 assert.match(sql,/Rollback bloqueado/);
});
test('salvamento atualiza cotas herdadas sem apagar histórico nem preço negociado',()=>{
 const sql=readFileSync(new URL('../../src/modules/service-packages/package.service.js',import.meta.url),'utf8');
 assert.match(sql,/UPDATE content_partner_terms SET mode=:mode,activation_limit=:limit/);
 assert.doesNotMatch(sql,/UPDATE content_partner_terms SET[^`]*fixed_fee_cents/);
 assert.match(sql,/SET live_snapshot=\s*CAST\(:snapshot AS jsonb\)/);
 const read=readFileSync(new URL('../../src/modules/partner-portal-sales/commercial-v2.service.js',import.meta.url),'utf8');
 assert.match(read,/livePackage/);
 assert.match(read,/historicalPackage/);
});
test('Admin delegado e cobrança de upgrade não congelam DNS e apps no parceiro',()=>{
 const network=readFileSync(new URL('../../src/modules/admin-workspaces/workspace.routes.js',import.meta.url),'utf8');
 assert.match(network,/maxServersOverride:planKey!==undefined\?null/);
 assert.match(network,/activation_limit_inherited=true/);
 assert.match(network,/UPDATE content_partner_terms SET mode=:mode,activation_limit=:limit/);
 const billing=readFileSync(new URL('../../src/modules/network-finance/finance.service.js',import.meta.url),'utf8');
 assert.match(billing,/maxAppsOverride:null,maxServersOverride:null/);
 assert.match(billing,/activation_limit_inherited=true/);
});
test('parceiro atualiza recursos ao voltar à aba sem alterar cobrança',()=>{
 const panel=readFileSync(new URL('../../../painel_parceiro/src/PortalSales.jsx',import.meta.url),'utf8');
 assert.match(panel,/visibilitychange/);
 assert.match(panel,/Apps próprios incluídos/);
 assert.match(panel,/moneyCents\(info.monthlyFeeCents/);
 const canonical=readFileSync(new URL('../../../shared/ui/src/ClientApps.jsx',import.meta.url),'utf8');
 assert.match(canonical,/visibilitychange/);
 assert.match(canonical,/Tentar novamente/);
});
test('modelo técnico administrado por Pacotes de Serviço não é alterado por editor paralelo',()=>{
 const source=readFileSync(new URL('../../src/modules/service-plans/catalog.routes.js',import.meta.url),'utf8');
 assert.match(source,/USE_SERVICE_PACKAGES/);
 assert.doesNotMatch(source,/router\.(put|post|delete)\(/);
});
