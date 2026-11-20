import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {assertPublicPlan,isHiddenNetworkPlan,isPubliclySelectablePlan} from '../../src/modules/service-plans/network-plan-visibility.js';
const src=p=>readFileSync(new URL(`../../src/${p}`,import.meta.url),'utf8');

test('plano oculto não entra em ofertas e retorna PLAN_HIDDEN sem alterar contratos',()=>{
 const hidden={active:true,hiddenFromNetwork:true};
 assert.equal(isHiddenNetworkPlan(hidden),true);
 assert.equal(isPubliclySelectablePlan(hidden),false);
 assert.throws(()=>assertPublicPlan(hidden),e=>e.status===403 && e.code==='PLAN_HIDDEN');
 assert.equal(isPubliclySelectablePlan({active:true,hiddenFromNetwork:false}),true);
 assert.equal(isPubliclySelectablePlan({active:false,hiddenFromNetwork:false}),false);
});
test('migração do catálogo é reversível e não modifica contratos atribuídos',async()=>{
 const require=createRequire(import.meta.url);
 const migration=require('../../src/db/migrations/20270111000001-hidden-network-plans.cjs');
 const calls=[];
 const fake={addColumn:async(...args)=>calls.push(['add',...args]),removeColumn:async(...args)=>calls.push(['remove',...args])};
 await migration.up(fake,{BOOLEAN:'boolean'});
 await migration.down(fake);
 assert.deepEqual(calls.map(x=>[x[0],x[1],x[2]]),[
  ['add','service_plan_catalogs','hidden_from_network'],['remove','service_plan_catalogs','hidden_from_network']]);
 assert.deepEqual(calls[0][3],{type:'boolean',allowNull:false,defaultValue:false});
 assert.doesNotMatch(src('db/migrations/20270111000001-hidden-network-plans.cjs'),/partner_service_plans/);
});
test('convites e listagem pública rejeitam catálogo oculto no backend',()=>{
 const invite=src('modules/admin-workspaces/network-invite-admin.routes.js');
 const redeem=src('modules/admin-workspaces/network-invite-public.routes.js');
 const packages=src('modules/partner-portal-sales/sales.routes.js');
 assert.match(invite,/hiddenFromNetwork:false/);
 assert.match(invite,/assertPublicPlan\(await scopedPlan/);
 assert.equal((redeem.match(/assertPublicPlan\(await scopedPlan/g)||[]).length,2);
 assert.match(packages,/hidden_from_network=false/);
});
test('precificação do portal bloqueia renovação self-service de plano oculto e mantém contrato legível',()=>{
 const pricing=src('modules/network-finance/pricing.service.js');
 assert.match(pricing,/if\(isHiddenNetworkPlan\(currentCatalog\)\)return/);
 assert.match(pricing,/renewalAvailable:false/);
 assert.match(pricing,/source==='partner'\)assertPublicPlan/);
 const routes=src('modules/network-finance/finance.routes.js');
 assert.match(routes,/PARTNER_CHARGE_FORBIDDEN/);
});
