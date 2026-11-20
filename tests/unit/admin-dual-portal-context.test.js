import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {loginContext,sessionContext,roleForContext} from '../../src/modules/auth/role-context.js';
const source=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');

test('Admin sem parceiro não entra nos portais; não ganha privilégios globais',()=>{
  const user={role:'admin',partnerId:null};
  assert.equal(loginContext(user,'admin'), 'admin');
  assert.equal(loginContext(user,'partner','both'),null);
  assert.equal(loginContext(user,'content_partner','both'),null);
  assert.equal(roleForContext('admin','partner',false),null);
});

test('Admin vinculado a conta ambas usa contextos separados por painel',()=>{
  const user={role:'admin',partnerId:'linked'};
  assert.equal(loginContext(user,'admin','both'),'admin');
  assert.equal(loginContext(user,'partner','both'),'partner');
  assert.equal(loginContext(user,'content_partner','both'),'partner');
  assert.equal(roleForContext('admin','admin',true),'admin');
  assert.equal(roleForContext('admin','partner',true),'partner');
});

test('Admin vinculado a apenas um tipo de portal não abre outro tipo',()=>{
  const user={role:'admin',partnerId:'linked'};
  assert.equal(loginContext(user,'content_partner','reseller'),null);
  assert.equal(loginContext(user,'partner','content'),null);
  assert.equal(loginContext(user,'partner','reseller'),'partner');
});

test('Login legado de Parceiro e renovação de sessões antigas mantêm comportamento',()=>{
  const user={role:'partner',partnerId:'x'};
  assert.equal(loginContext(user,'partner','content'),'partner');
  assert.equal(loginContext(user,'content_partner','reseller'),null);
  assert.equal(loginContext(user,'admin','both'),null);
  assert.equal(sessionContext('legacy','partner'),'partner');
  assert.equal(sessionContext('legacy','admin'),'admin');
  assert.equal(sessionContext('content_partner','admin'),'partner');
});

test('Migração preserva cadastro e só amplia a vinculação sob autorização da DeltaTV',()=>{
  const sql=source('../../src/db/migrations/20261230000001-admin-dual-portal-context.cjs');
  assert.match(sql,/ck_admin_user_portal_link/);
  assert.match(sql,/role='admin'/);
  assert.match(sql,/addColumn\('auth_sessions','audience'/);
  assert.doesNotMatch(sql,/DELETE FROM|TRUNCATE|DROP TABLE/i);
  const route=source('../../src/modules/users/users.routes.js');
  assert.match(route,/assignPortalAccountToAdmin/);
  assert.match(route,/PARTNER_OWNED_BY_OTHER_ADMIN/);
  assert.match(route,/PARTNER_ALREADY_LINKED/);
  const guard=source('../../src/modules/admin.routes.js');
  assert.match(guard,/ADMIN_PORTAL_DENIED/);
  const auth=source('../../src/middleware/authenticate.js');
  assert.match(auth,/actualContext !== expectedContext/);
  assert.match(auth,/isNetworkPortalAccessible\(partner,session\.audience\)/);
  assert.match(auth,/renewalOnly/);
  assert.match(auth,/attributes:\['id','kind','status','endsAt','ownerAdminId'\]/);
});
