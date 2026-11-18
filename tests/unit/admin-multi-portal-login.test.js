import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sessionContext, roleForContext} from '../../src/modules/auth/role-context.js';
const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');

test('Admin sem conta pode autenticar em ambos portais e selecionar conta depois',()=>{
 for(const audience of ['partner','content_partner']){
  assert.equal(sessionContext(audience,'admin',null),'portal_select');
 }
 assert.equal(roleForContext('admin','portal_select',false),'portal_select');
 assert.equal(roleForContext('partner','portal_select',false),null);
 assert.equal(roleForContext('superadmin','portal_select',false),null);
});

test('Conta selecionada gera role operacional e admin nao herda privilegio global',()=>{
 assert.equal(sessionContext('content_partner','admin','uuid'),'partner');
 assert.equal(sessionContext('partner','admin','uuid'),'partner');
 assert.equal(roleForContext('admin','partner',true),'partner');
 assert.equal(roleForContext('admin','admin',false),'admin');
 assert.equal(roleForContext('partner','admin',true),null);
});

test('Selecionar outra conta exige mesma rede, audiencia, sessao e conta ativa',()=>{
 const accounts=source('../../src/modules/auth/portal-accounts.service.js');
 assert.match(accounts,/ownerAdminId:\s*admin\.id/);
 assert.match(accounts,/status:\s*'active'/);
 assert.match(accounts,/kind:\s*\{\s*\[Op\.in\]:\s*portalKinds\(audience\)/);
 assert.match(accounts,/return Partner\.findOne/);
 const auth=source('../../src/modules/auth/auth.service.js');
 assert.match(auth,/findPortalAccount\(user,session\.audience,partnerId,transaction\)/);
 assert.match(auth,/session\.update\(\{revokedAt:new Date\(\)\}/);
 const claims=source('../../src/middleware/authenticate.js');
 assert.match(claims,/findPortalAccount\(user,session\.audience,selectedPortalPartnerId\)/);
 assert.match(claims,/portalPartnerId/);
 const adminRoutes=source('../../src/modules/admin.routes.js');
 assert.match(adminRoutes,/!\['superadmin','support','admin'\]\.includes\(req\.user\?\.role\)/);
});

test('Migração conserva as identidades, preserva sessoes operacionais antigas',()=>{
 const migration=source('../../src/db/migrations/20270106000001-admin-portal-account-sessions.cjs');
 assert.match(migration,/addColumn\('auth_sessions',\s*'portal_partner_id'/);
 assert.match(migration,/UPDATE auth_sessions s SET portal_partner_id=u.partner_id/);
 assert.doesNotMatch(migration,/DROP TABLE|TRUNCATE TABLE|DELETE FROM/i);
});

test('Os dois paineis mostram seletor com sessao vinculada; painel Admin oferece ambos links',()=>{
 const revenda=source('../../../revenda/src/App.jsx');
 const parceiro=source('../../../painel_parceiro/src/App.jsx');
 const admin=source('../../../admin/src/App.jsx');
 assert.match(revenda,/role === 'portal_select'/);
 assert.match(parceiro,/role==='portal_select'/);
 assert.match(revenda,/AdminPortalAccounts/);
 assert.match(parceiro,/AdminPortalAccounts/);
 assert.match(admin,/Abrir meu Painel do Parceiro/);
 assert.match(admin,/Abrir minha Revenda/);
});
