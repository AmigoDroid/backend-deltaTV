import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url),'utf8');

test('Superadmin vê limite de apps na página de Pacotes de Serviço',()=>{
 const page=read('../../../admin/src/pages/ServicePackages.jsx');
 const router=read('../../../admin/src/App.jsx');
 assert.match(page,/Apps próprios incluídos/);
 assert.match(page,/maxApps:0/);
 assert.match(router,/"service-packages": \["Pacotes de serviço", ServicePackages\]/);
});

test('Admin delegado abre a própria tela de planos com limite de apps',()=>{
 const view=read('../../../admin/src/pages/NetworkWorkspace.jsx');
 const router=read('../../../admin/src/App.jsx');
 const permissions=read('../../../admin/shared/permissions.js');
 assert.match(router,/user\.role === "admin" && page !== "downloads"[\s\S]*?<NetworkWorkspace/);
 assert.match(permissions,/"service-packages": \{permission:"network:plans:read", view:"plans"\}/);
 assert.match(view,/Apps próprios incluídos/);
 assert.match(view,/activationLimit:f\.noActivationLimit\?null:Number\(f\.activationLimit\),maxApps:Number\(f\.maxApps\)/);
 assert.match(view,/<th>Apps próprios<\/th>/);
 assert.match(view,/maxApps:String\(p\.maxApps\?\?0\)/);
});

test('Backend de rede respeita escopo e protege redução de vagas',()=>{
 const route=read('../../src/modules/admin-workspaces/workspace.routes.js');
 assert.match(route,/maxApps: z\.number\(\)\.int\(\)\.min\(0\)\.max\(50\)\.optional\(\)/);
 assert.match(route,/ServicePlanCatalog\.findOne\(\{where:\{key,ownerAdminId:root,deletedAt:null\}/);
 assert.match(route,/if\(body\.maxApps!==undefined && body\.maxApps<p\.maxApps\)/);
 assert.match(route,/assertNoSlotDowngrade\(row\.partnerId,body\.maxApps,t\)/);
 assert.match(route,/assertNoSlotDowngrade\(p\.id,newSlotLimit,t\)/);
 assert.match(route,/requireScope\("network:plans:write"\)/);
 assert.match(route,/maxAppsOverride:null/);
});
