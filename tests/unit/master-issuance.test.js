import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPrimaryMaster, maySelfIssue } from '../../src/modules/distribution/master-issuance.policy.js';
const active = {kind:'reseller',distributionRole:'master',parentPartnerId:null,status:'active',endsAt:'2099-01-01'};
test('apenas Master principal independente é elegível',()=>{
  assert.equal(isPrimaryMaster(active),true);
  assert.equal(isPrimaryMaster({...active,parentPartnerId:'uuid'}),false);
  assert.equal(isPrimaryMaster({...active,distributionRole:'reseller'}),false);
  assert.equal(isPrimaryMaster({...active,kind:'content'}),false);
  assert.equal(isPrimaryMaster({...active,kind:'both'}),true);
});
test('Master principal depende de autorização explícita',()=>{
  assert.equal(maySelfIssue(active,true),true);
  assert.equal(maySelfIssue(active,false),false);
  assert.equal(maySelfIssue(active,null),false);
});
test('Submaster não emite mesmo quando flag está habilitada',()=>{
  assert.equal(maySelfIssue({...active,parentPartnerId:'uuid'},true),false);
});
test('Conta suspensa/vencida não emite',()=>{
  assert.equal(maySelfIssue({...active,status:'suspended'},true),false);
  assert.equal(maySelfIssue({...active,endsAt:'2000-01-01'},true),false);
});
test('Somente o Superadmin pode configurar permissão, e solicitação é idempotente',()=>{
  const routes=readFileSync(new URL('../../src/modules/distribution/network.routes.js',import.meta.url),'utf8');
  const service=readFileSync(new URL('../../src/modules/distribution/master-issuance.service.js',import.meta.url),'utf8');
  assert.match(routes,/\/accounts\/:id\/self-issuance/);
  assert.match(routes,/req\.user\.role!=="superadmin"/);
  assert.match(service,/idempotency_key/);
  assert.match(service,/alreadyProcessed:true/);
  assert.match(service,/isPrimaryMaster\(partner\)/);
});
test('Mudanças de hierarquia revogam a autorização',()=>{
  const code=readFileSync(new URL('../../src/modules/distribution/network.service.js',import.meta.url),'utf8');
  assert.equal((code.match(/UPDATE reseller_master_issuance_permissions SET enabled=false/g)||[]).length,1);
  assert.match(code,/if \(!master \|\| target\.parentPartnerId\)/);
});
