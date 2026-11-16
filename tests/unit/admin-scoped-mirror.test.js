import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
test('nenhum Admin comum consegue chamar as APIs administrativas globais',()=>{
 const global=read('../../src/modules/admin.routes.js');
 assert.match(global,/req\.user\?\.role === "admin" && !/);
 assert.match(global,/ADMIN_WORKSPACE_ONLY/);
});
test('consultas do espelho aplicam proprietário e não expõem ficha comercial sem autorização',()=>{
 const routes=read('../../src/modules/admin-workspaces/workspace.routes.js');
 assert.match(routes,/req\.networkOwnerId=req\.user\.id/);
 assert.match(routes,/ownerAdminId:tenant\(req\)/);
 assert.match(routes,/const partner=direct\?p:\{id:p\.id,name:p\.name,kind:p\.kind,status:p\.status\}/);
 assert.match(routes,/const attributes=canSeeContract\?/);
 assert.match(routes,/hasIndirectAccountRead\(req\)/);
});
