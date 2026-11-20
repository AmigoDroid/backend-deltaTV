import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {effectivePartnerStatus} from '../../src/modules/access/access.policy.js';

const source = relative => readFileSync(new URL(relative,import.meta.url),'utf8');
const now = new Date('2026-11-20T12:00:00.000Z');

test('Admin / DeltaTV: active vencido é expired, sem alterar status salvo',()=>{
 const partner={status:'active',endsAt:new Date('2026-11-19T12:00:00Z')};
 assert.equal(effectivePartnerStatus(partner,now),'expired');
 assert.equal(partner.status,'active');
});
test('Admin / DeltaTV: active vigente é active e bloqueio prevalece ao vencimento',()=>{
 assert.equal(effectivePartnerStatus({status:'active',endsAt:'2026-11-22'},now),'active');
 assert.equal(effectivePartnerStatus({status:'blocked',endsAt:'2026-11-01'},now),'blocked');
 assert.equal(effectivePartnerStatus({status:'suspended',endsAt:'2026-11-01'},now),'suspended');
});
test('Lista DeltaTV/Admin usa o MESMO filtro expired/pending e mesma função de status',()=>{
 const global=source('../../src/modules/partners/partner.service.js');
 const workspace=source('../../src/modules/admin-workspaces/workspace.routes.js');
 const query=source('../../src/modules/partners/partner-status.query.js');
 assert.match(global,/partnerStatusWhere\(status\)/);
 assert.match(workspace,/partnerStatusWhere\(status\)/);
 assert.match(query,/status === "expired".*endsAt:.*Op\.lte/);
 assert.match(query,/status === "pending".*SIGNUP_PENDING_REASON/);
 assert.match(workspace,/effectivePartnerStatus\(p\)/);
 assert.match(workspace,/rows\.map\(p=>partnerStatusOut\(p,\{canSeeContract:maySeeContract\(p\)\}\)\)/);
 assert.match(workspace,/p.kind === "both" \? directPartners && directResellers/);
 assert.match(workspace,/delete data\.endsAt/);
});
test('IDOR: usuário Admin obtém owner da sessão, CRUD checa owner no SELECT',()=>{
 const code=source('../../src/modules/admin-workspaces/workspace.routes.js');
 const service=source('../../src/modules/partners/partner.service.js');
 assert.match(code,/req\.networkOwnerId=req\.user\.id/);
 assert.match(code,/where:\{id,ownerAdminId:adminId/);
 assert.match(code,/ownedPartner\(tenant\(req\),req\.valid\.params\.id/);
 assert.match(service,/ownerAdminId === undefined \? \{ id \} : \{ id, ownerAdminId \}/);
 assert.match(code,/ADMIN_WORKSPACE_ONLY/);
 assert.match(source('../../src/modules/admin.routes.js'),/ADMIN_WORKSPACE_ONLY/);
});
test('Admin não consegue promover usuários nem acessar rotas globais e VPS',()=>{
 const perms=source('../../src/modules/admin-workspaces/permissions.js');
 const scoped=source('../../src/modules/admin-workspaces/workspace.routes.js');
 assert.doesNotMatch(perms,/"vps:|"users:manage|"platform:write/);
 assert.doesNotMatch(scoped,/router\.(get|post|put|patch|delete)\(["'`]\/vps/);
 assert.match(scoped,/role:"partner",partnerId:partner\.id/);
 assert.match(source('../../src/modules/admin.routes.js'),/if \(req\.user\?\.role === "admin" && !\/\^\\\/workspace/);
});
