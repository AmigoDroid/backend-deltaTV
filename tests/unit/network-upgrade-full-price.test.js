import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateChargePricing,requiredSettlementCents} from '../../src/modules/network-finance/charge-pricing.js';

const now=new Date('2026-11-20T12:00:00-03:00');
const endsAt=new Date('2026-12-10T12:00:00-03:00');
const input={kind:'upgrade',planPriceCents:1600000,oldPlanPriceCents:0,
 validityDays:30,endsAt,effectiveStatus:'active',now};

test('compra de upgrade gratuito para plano de R$ 16.000 cobra valor integral mesmo com dias restantes',()=>{
 const quote=calculateChargePricing({...input,fullUpgradePrice:true});
 assert.equal(quote.baseCents,1600000);
 assert.equal(quote.totalCents,1600000);
 assert.equal(quote.fullPlanPriceCents,1600000);
 assert.equal(quote.fullUpgradePrice,true);
 assert.ok(Object.isFrozen(quote));
});

test('upgrade pelo Master e cobranças antigas preservam o cálculo proporcional',()=>{
 const previous=calculateChargePricing(input);
 assert.ok(previous.baseCents<1600000);
 assert.equal(previous.fullUpgradePrice,false);
 const nonzero=calculateChargePricing({...input,oldPlanPriceCents:800000,fullUpgradePrice:true});
 assert.equal(nonzero.totalCents,1600000);
});

test('a reconciliação após expiração do Pix preserva o valor integral da compra',()=>{
 const quote=calculateChargePricing({...input,fullUpgradePrice:true});
 assert.equal(requiredSettlementCents(quote,new Date('2026-11-21T12:00:00-03:00')),1600000);
 const old=calculateChargePricing(input);
 assert.equal(requiredSettlementCents(old,new Date('2026-11-21T12:00:00-03:00')),calculateChargePricing({...input,now:new Date('2026-11-21T12:00:00-03:00')}).totalCents);
});

test('prévia do parceiro usa preço cheio e o modal não menciona proporcionalidade',()=>{
 const quoteSource=readFileSync(new URL('../../src/modules/network-finance/pricing.service.js',import.meta.url),'utf8');
 assert.match(quoteSource,/fullUpgradePrice:source==='partner'&&kind==='upgrade'/);
 const viewSource=readFileSync(new URL('../../../painel_parceiro/src/PlanUpgrade.jsx',import.meta.url),'utf8');
 assert.match(viewSource,/Valor integral a pagar agora/);
 assert.doesNotMatch(viewSource,/Valor proporcional a pagar agora/);
});
