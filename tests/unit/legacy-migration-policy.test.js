import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessLegacyRecord } from '../../src/modules/legacy-migration/legacy-migration.policy.js';

const valid = Object.freeze({
  partnerId:'11111111-1111-4111-8111-111111111111', activationCount:1,activationStatus:'active',
  licenseStatus:'active',licenseExpiresAt:'2099-01-01T00:00:00Z', licenseOwnerPartnerId:null,
  commerceCustomerId:'22222222-2222-4222-8222-222222222222', otherPartnerCount:0, linkedSubscriptionId:null,
});
test('licença vigente e mesmo parceiro ficam prontos somente para associação comercial',()=>{
  assert.equal(assessLegacyRecord(valid).state,'ready');
});
test('vínculo comercial existente é tratado como já migrado',()=>{
  assert.equal(assessLegacyRecord({...valid,linkedSubscriptionId:'any'}).state,'linked');
});
test('nunca criar automaticamente uma ficha para MAC sem licença/ativação',()=>{
  for(const patch of [
    {activationCount:0}, {activationCount:2}, {activationStatus:'blocked'},
    {licenseStatus:'suspended'}, {licenseExpiresAt:'2020-01-01T00:00:00Z'},
    {licenseOwnerPartnerId:'33333333-3333-4333-8333-333333333333'},
    {otherPartnerCount:2},
  ]) assert.equal(assessLegacyRecord({...valid,...patch}).state,'review',JSON.stringify(patch));
});
test('ficha comercial não importada é etapa separada da licença',()=>{
  assert.equal(assessLegacyRecord({...valid,commerceCustomerId:null}).state,'needs_customer');
});
test('rotas de migração exigem Superadmin e confirmação expressa',()=>{
  const path = new URL('../../src/modules/legacy-migration/legacy-migration.routes.js', import.meta.url);
  const src = readFileSync(path,'utf8');
  assert.match(src,/role === 'superadmin'/);
  assert.match(src,/acknowledgeNoLicenseChange: z\.literal\(true\)/);
  assert.match(src,/requirePermission\('devices:write'\)/);
});
test('operações de importação e vínculo nunca atualizam licenças, dispositivos ou estoque',()=>{
  const path = new URL('../../src/modules/legacy-migration/legacy-migration.service.js',import.meta.url);
  const src = readFileSync(path,'utf8');
  assert.doesNotMatch(src,/(UPDATE|INSERT INTO|DELETE FROM)\s+(licenses|devices|activations|reseller_license_stock|credit_ledger)\b/i);
  assert.match(src,/FOR UPDATE/);
  assert.match(src,/SELECT count\(\*\)::int AS n FROM commerce_subscription_slots/);
  assert.match(src,/legacy\.activation\.commercial-link/);
});
