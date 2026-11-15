import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isPrimaryMaster, maySelfIssue } from '../../src/modules/distribution/master-issuance.policy.js';
const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
test('somente Master principal independente é elegível para emitir', () => {
  const master={kind:'reseller',distributionRole:'master',parentPartnerId:null,status:'active'};
  assert.equal(maySelfIssue(master,true),true);
  assert.equal(maySelfIssue({...master,parentPartnerId:'child'},true),false);
  assert.equal(maySelfIssue({...master,distributionRole:'submaster'},true),false);
  assert.equal(maySelfIssue(master,false),false);
  assert.equal(isPrimaryMaster({...master,status:'suspended'}),true);
  assert.equal(maySelfIssue({...master,status:'suspended'},true),false);
});
test('emissão direta valida autorização e registra transação idempotente',()=>{
  const service=read('../../src/modules/stock/direct-device-activation.service.js');
  assert.match(service,/isPrimaryMaster\(partner\)/);
  assert.match(service,/maySelfIssue\(partner, permitted\?\.enabled/);
  assert.match(service,/ON CONFLICT \(issuer_type,issuer_id,idempotency_key\) DO NOTHING/);
  assert.match(service,/applyOnce\(\{ partner, actor, device, months, consumeStock: false/);
  assert.match(service,/await sequelize\.transaction/);
  assert.match(service,/alreadyProcessed: true/);
});
test('conta normal não recebe rota de emissão direta sem autorização',()=>{
  const partner=read('../../src/modules/portal/portal.routes.js');
  const admin=read('../../src/modules/licenses/license.routes.js');
  assert.match(partner,/"\/license-activation\/direct", stockWriteLimiter, requireReseller/);
  assert.match(admin,/req\.user\.role !== "superadmin"/);
  assert.match(partner,/"\/stock\/apply"/);
});
test('emissão direta não deve consumir estoque da revenda',()=>{
  const stock=read('../../src/modules/stock/stock.service.js');
  assert.match(stock,/if \(consumeStock\) await move\(t,/);
  assert.match(stock,/consumeStock \? "stock\.apply" : "license\.direct_apply"/);
  const migration=read('../../src/db/migrations/20261216000001-license-direct-device-activation.cjs');
  assert.match(migration,/PRIMARY KEY \(issuer_type, issuer_id, idempotency_key\)/);
});
