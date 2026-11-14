import test from 'node:test';
import assert from 'node:assert/strict';
import {commissionCredits,availableSlots,entitlementState} from '../../src/modules/commerce/commerce.policy.js';

test('comissão calcula em inteiros sem arredondamento flutuante',()=>{
  assert.equal(commissionCredits(1000,600),60);
  assert.equal(commissionCredits(1,3333),0);
  assert.equal(commissionCredits(987654321,1250),123456790);
  assert.equal(commissionCredits(Number.MAX_SAFE_INTEGER,10000),Number.MAX_SAFE_INTEGER);
});
test('comissão rejeita taxas e créditos inválidos',()=>{
  for(const [amount,rate] of [[-1,100],[100,10001],[100,1.5],[NaN,100]])
    assert.throws(()=>commissionCredits(amount,rate));
});
test('vagas 0 bloqueiam; null é ilimitado; liberação restaura vaga',()=>{
  assert.equal(availableSlots(0,0),0);
  assert.equal(availableSlots(null,100),null);
  assert.equal(availableSlots(4,3),1);
  assert.equal(availableSlots(4,4),0);
  assert.equal(availableSlots(4,100),0);
});
test('a tolerância distingue ativo de atrasado e restrito',()=>{
  const now=new Date('2026-11-14T12:00:00Z');
  assert.equal(entitlementState({state:'active',graceDays:5,dueAt:'2026-11-15T00:00:00Z'},now),'active');
  assert.equal(entitlementState({state:'active',graceDays:5,dueAt:'2026-11-12T00:00:00Z'},now),'past_due');
  assert.equal(entitlementState({state:'active',graceDays:5,dueAt:'2026-11-01T00:00:00Z'},now),'restricted');
  assert.equal(entitlementState({state:'suspended',graceDays:5,dueAt:null},now),'suspended');
});
