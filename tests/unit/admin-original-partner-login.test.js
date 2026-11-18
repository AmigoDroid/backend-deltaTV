import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path,import.meta.url),'utf8');
const src = read('../../src/modules/auth/portal-accounts.service.js');
function mockedModule({previous=[],original=null,owned=null,updated=1}={}) {
  const calls=[];
  const Op={in:Symbol('in'),or:Symbol('or'),ne:Symbol('ne'),iLike:Symbol('iLike')};
  const models={
    Partner:{findOne:async args=>{calls.push(['partner.findOne',args]);return original || owned;},findAndCountAll:async()=>({rows:[],count:0})},
    LoginHistory:{findAll:async args=>{calls.push(['history',args]);return previous;}},
    AdminUser:{update:async (values,options)=>{calls.push(['update',values,options]);return [updated]},findByPk:async()=>({partnerId:original?.id})}
  };
  const body=src.replace(/^import .*;\s*$/gm,'').replace(/\bexport (function|async function)\b/g,'$1');
  const context=vm.createContext({Op,...models,PORTAL_AUDIENCES:['partner','content_partner']});
  const exported=vm.runInContext(`${body}\n({ portalAccountFilter, defaultPortalAccount, restoreOriginalPortalAccount, findPortalAccount })`,context);
  return { ...exported,calls,Op };
}

test('Sem vínculo o login não escolhe automaticamente outro parceiro da rede',async()=>{
  const m=mockedModule({owned:{id:'outra-conta',kind:'content',status:'active'}});
  assert.equal(await m.defaultPortalAccount({id:'admin1',role:'admin',partnerId:null},'content_partner'),null);
  assert.equal(m.calls.length,0);
});

test('Admin vinculado entra na parceria original, ainda que ela pertença a outra rede',async()=>{
  const original={id:'conta-original',kind:'content',status:'active',ownerAdminId:'outro-admin'};
  const m=mockedModule({original});
  const admin={id:'admin1',role:'admin',partnerId:'conta-original'};
  assert.equal((await m.defaultPortalAccount(admin,'content_partner')).id,'conta-original');
  const where=m.calls.find(x=>x[0]==='partner.findOne')[1].where;
  assert.equal(where.id,'conta-original');
  assert.equal(where.id,'conta-original');
});

test('Não permite selecionar outra parceria pelo endpoint legado, mesmo com ID válido',async()=>{
  const m=mockedModule({owned:{id:'teste-parceiro',kind:'content',status:'active'}});
  const admin={id:'admin1',role:'admin',partnerId:'conta-original'};
  assert.equal(await m.findPortalAccount(admin,'content_partner','teste-parceiro'),null);
  assert.ok(!m.calls.some(x=>x[0]==='partner.findOne'));
});

test('Recuperação de identidade antiga exige um único vínculo histórico verificado',async()=>{
  const original={id:'conta-original',kind:'content',status:'active'};
  const m=mockedModule({previous:[{partnerId:'conta-original'}],original});
  const admin={id:'admin1',role:'admin',partnerId:null};
  assert.equal((await m.restoreOriginalPortalAccount(admin,'content_partner')).id,'conta-original');
  assert.equal(admin.partnerId,'conta-original');
  const query=m.calls.find(x=>x[0]==='history')[1];
  assert.equal(query.where.adminUserId,'admin1');
  assert.equal(query.where.role,'partner');
  assert.equal(query.where.outcome,'success');
  const update=m.calls.find(x=>x[0]==='update');
  assert.deepEqual(JSON.parse(JSON.stringify(update[1])),{partnerId:'conta-original'});
});

test('Promoção com vínculo equivocado para conta de teste recupera o original comprovado no histórico',async()=>{
  const original={id:'conta-original',kind:'content',status:'active'};
  const m=mockedModule({previous:[{partnerId:'conta-original'}],original});
  const admin={id:'admin1',role:'admin',partnerId:'teste-parceiro'};
  assert.equal((await m.restoreOriginalPortalAccount(admin,'content_partner')).id,'conta-original');
  assert.equal(admin.partnerId,'conta-original');
  const update=m.calls.find(x=>x[0]==='update');
  assert.equal(update[2].where.partnerId,'teste-parceiro');
});

test('Histórico ambíguo não escolhe conta nem modifica vínculo',async()=>{
  const m=mockedModule({previous:[{partnerId:'x'},{partnerId:'y'}],original:{id:'x'}});
  const admin={id:'admin1',role:'admin',partnerId:null};
  assert.equal(await m.restoreOriginalPortalAccount(admin,'content_partner'),null);
  assert.equal(admin.partnerId,null);
  assert.ok(!m.calls.some(x=>x[0]==='update'));
});

test('Promoção de Parceiro para Admin não transfere automaticamente a parceria original',()=>{
  const userRoutes=read('../../src/modules/users/users.routes.js');
  const auth=read('../../src/modules/auth/auth.service.js');
  assert.match(userRoutes,/const preservingOriginal = u\.role === 'partner' && role === 'admin' && partnerId === u\.partnerId/);
  assert.match(userRoutes,/partnerId && !preservingOriginal/);
  assert.match(auth,/restoreOriginalPortalAccount\(user, targetAudience\)/);
  assert.match(auth,/defaultPortalAccount\(user, targetAudience\)/);
});
