import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionContext, roleForContext } from '../../src/modules/auth/role-context.js';
const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('Admin vinculado usa sempre seu cadastro operacional original nos portais',()=>{
 for(const audience of ['partner','content_partner']){
  assert.equal(sessionContext(audience,'admin','id-parceiro-original'),'partner');
 }
 assert.equal(roleForContext('admin','partner',true),'partner');
 assert.equal(roleForContext('admin','admin',false),'admin');
 assert.equal(roleForContext('partner','admin',true),null);
});

test('Login sem parceria não cria sessão de seleção nem escolhe conta da rede',()=>{
 const auth=source('../../src/modules/auth/auth.service.js');
 assert.match(auth,/if \(user\.role === 'admin' && PORTAL_AUDIENCES\.includes\(targetAudience\) && !selected\)/);
 assert.match(auth,/ORIGINAL_PARTNER_LINK_REQUIRED/);
 assert.match(auth,/restoreOriginalPortalAccount\(user, targetAudience\)/);
 const claims=source('../../src/middleware/authenticate.js');
 assert.match(claims,/!session\.portalPartnerId/);
});

test('Nenhum portal mostra seletor de contas ou permite alternância',()=>{
 const revenda=source('../../../revenda/src/App.jsx');
 const parceiro=source('../../../painel_parceiro/src/App.jsx');
 const partnerApi=source('../../src/modules/auth/portal-accounts.service.js');
 assert.doesNotMatch(parceiro,/import AdminPortalAccounts|<AdminPortalAccounts/);
 assert.doesNotMatch(revenda,/import AdminPortalAccounts|<AdminPortalAccounts/);
 assert.match(partnerApi,/id: admin\.partnerId/);
 assert.doesNotMatch(partnerApi,/ownerAdminId: admin\.id/);
 const admin=source('../../../admin/src/App.jsx');
 assert.match(admin,/Abrir meu Painel do Parceiro/);
});

test('Sessões de portal são isoladas e não ganham permissões globais',()=>{
 const claims=source('../../src/middleware/authenticate.js');
 assert.match(claims,/findPortalAccount\(user,session\.audience,selectedPortalPartnerId\)/);
 const adminRoutes=source('../../src/modules/admin.routes.js');
 assert.match(adminRoutes,/!\['superadmin','support','admin'\]\.includes\(req\.user\?\.role\)/);
 const migration=source('../../src/db/migrations/20270106000001-admin-portal-account-sessions.cjs');
 assert.match(migration,/addColumn\('auth_sessions',\s*'portal_partner_id'/);
 assert.doesNotMatch(migration,/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
});
