import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateChargePricing as price,localDayDifference,pixExpiry,endOfLocalDay,upgradeBaseCents,requiredSettlementCents,
 validateSettings} from '../../src/modules/network-finance/charge-pricing.js';
import {verifyNetworkPaymentMatch} from '../../src/modules/network-finance/policy.js';
const day=(d)=>new Date(`${d}T12:00:00-03:00`);
const base=(o={})=>({kind:'renewal',planPriceCents:5000,validityDays:30,planKey:'plus',
 endsAt:day('2026-11-01'),effectiveStatus:'expired',now:day('2026-11-07'),...o});
test('dias corridos de atraso em Sao Paulo, 1/6/30/90',()=>{
 for(const [d,expected] of [[1,1],[6,6],[30,30],[90,90]]){
  const now=new Date(day('2026-11-01').getTime()+d*86400000);
  assert.equal(price(base({now})).daysLate,expected);
 }
 assert.equal(localDayDifference(day('2026-11-01'),day('2026-11-07')),6);
});
test('multa única, juros simples sobre base do plano sem capitalizar e sem cobrar tolerância parcial',()=>{
 const q=price(base());
 assert.deepEqual([q.lateFeeCents,q.interestCents,q.totalCents],[100,10,5110]);
 assert.equal(price(base({now:day('2026-12-01')})).lateFeeCents,100);
 assert.equal(price(base({now:day('2026-12-01')})).interestCents,50);
 assert.equal(price(base({settings:{toleranceDays:6}})).totalCents,5000);
 assert.equal(price(base({settings:{toleranceDays:5}})).totalCents,5110);
});
test('juros half-up arredondados uma vez e taxa 0/10 dias',()=>{
 const q=price(base({planPriceCents:101,now:day('2026-11-07')}));
 assert.equal(q.lateFeeCents,2);assert.equal(q.interestCents,0);
 assert.equal(price(base({planPriceCents:150,now:day('2026-12-01')})).interestCents,2);
 assert.equal(price(base({settings:{lateFeeEnabled:false}})).totalCents,5000);
});
test('desconto antecipado respeita limite N, N-1, vencimento e atraso',()=>{
 const settings={earlyDiscountEnabled:true,earlyDiscountType:'percent',earlyDiscountValue:10,earlyMinDaysBefore:5};
 assert.equal(price(base({endsAt:day('2026-12-06'),now:day('2026-12-01'),effectiveStatus:'active',settings})).earlyDiscountCents,500);
 assert.equal(price(base({endsAt:day('2026-12-06'),now:day('2026-12-02'),effectiveStatus:'active',settings})).earlyDiscountCents,0);
 assert.equal(price(base({endsAt:day('2026-12-06'),now:day('2026-12-06'),effectiveStatus:'active',settings:{...settings,earlyMinDaysBefore:0}})).earlyDiscountCents,500);
 assert.equal(price(base({settings})).earlyDiscountCents,0);
});
test('campanha com limites inclusivos e lista de planos',()=>{
 const settings={earlyDiscountEnabled:true,earlyDiscountType:'fixed_cents',earlyDiscountValue:6000,
  earlyPlanKeys:['plus'],earlyStartsAt:day('2026-12-01').toISOString(),earlyEndsAt:day('2026-12-10').toISOString()};
 const b=base({endsAt:day('2026-12-20'),effectiveStatus:'active',settings});
 assert.equal(price({...b,now:day('2026-12-01')}).earlyDiscountCents,4900);
 assert.equal(price({...b,now:day('2026-12-10')}).earlyDiscountCents,4900);
 assert.equal(price({...b,now:day('2026-11-30')}).earlyDiscountCents,0);
 assert.equal(price({...b,now:day('2026-12-11')}).earlyDiscountCents,0);
 assert.equal(price({...b,now:day('2026-12-05'),planKey:'other'}).earlyDiscountCents,0);
});
test('manual em dias/percentual versus antecipado, maior ou acumular',()=>{
 const b=base({now:day('2026-12-01'),endsAt:day('2026-12-30'),effectiveStatus:'active',
  settings:{earlyDiscountEnabled:true,earlyDiscountValue:10}});
 const manual={type:'percent',value:15};
 let q=price({...b,manual});assert.deepEqual([q.earlyDiscountCents,q.manualDiscountCents,q.totalCents],[0,750,4250]);
 q=price({...b,manual:{...manual,stack:true}});
 assert.deepEqual([q.earlyDiscountCents,q.manualDiscountCents,q.totalCents],[500,750,3750]);
 q=price({...b,manual:{type:'days',value:3}});assert.equal(q.totalCents,4500);
 assert.throws(()=>price({...b,manual:{type:'days',value:30}}),RangeError);
});
test('abono parcial/total não altera base e exige motivo',()=>{
 let q=price(base({waiver:{reason:'Acordo documentado',lateFeeCents:50,interestCents:5}}));
 assert.deepEqual([q.baseCents,q.lateFeeCents,q.interestCents,q.waiverFeeCents,q.waiverInterestCents,q.totalCents],[5000,100,10,50,5,5055]);
 q=price(base({waiver:{reason:'Acordo documentado',full:true}}));assert.equal(q.totalCents,5000);
 assert.throws(()=>price(base({waiver:{full:true}})),RangeError);
});
test('total jamais abaixo do mínimo, multa e juros percentuais sujeitos ao teto',()=>{
 const q=price(base({effectiveStatus:'active',now:day('2026-10-01'),endsAt:day('2026-11-01'),
  settings:{minChargeCents:150,earlyDiscountEnabled:true,earlyDiscountValue:100}}));
 assert.equal(q.totalCents,150);
 assert.throws(()=>validateSettings({lateFeePct:2.01}),/teto/);
 assert.throws(()=>validateSettings({interestMonthlyPct:1.01}),/teto/);
 assert.throws(()=>validateSettings({toleranceDays:11}),RangeError);
});
test('upgrade vencido: plano novo integral + encargos do plano antigo',()=>{
 const q=price(base({kind:'upgrade',planPriceCents:10000,oldPlanPriceCents:5000}));
 assert.deepEqual([q.baseCents,q.lateBaseCents,q.lateFeeCents,q.interestCents,q.totalCents],[10000,5000,100,10,10110]);
 assert.equal(upgradeBaseCents({oldPriceCents:5000,newPriceCents:10000,validityDays:30,
  endsAt:day('2026-12-16'),now:day('2026-12-01')}),2500);
});
test('vencimento Pix corta meia-noite local, inclusive UTC no dia seguinte',()=>{
 const now=new Date('2026-12-01T23:50:00-03:00');
 assert.equal(pixExpiry(now,60).toISOString(),'2026-12-02T02:59:59.000Z');
 assert.equal(endOfLocalDay(now).getTime(),pixExpiry(now).getTime());
 assert.equal(price(base({now:day('2026-11-07')})).interestCents,10);
 assert.equal(price(base({now:day('2026-11-08')})).interestCents,12);
});
test('confirmação comprovada exige referência e conta corretas, mas aceita valor excedente',()=>{
 const charge={id:'abc',provider_ref:'provider',amount_cents:5000};
 const payment={confirmed:true,externalReference:'abc',providerRef:'provider',currency:'BRL',paymentMethod:'pix',collectorId:'owner',amountCents:5000};
 assert.equal(verifyNetworkPaymentMatch(charge,payment,'owner'),true);
 assert.equal(verifyNetworkPaymentMatch(charge,{...payment,amountCents:4999},'owner'),false);
 assert.equal(verifyNetworkPaymentMatch(charge,{...payment,amountCents:6000},'owner'),true);
 assert.equal(verifyNetworkPaymentMatch(charge,{...payment,externalReference:'other'},'owner'),false);
 assert.equal(verifyNetworkPaymentMatch(charge,{...payment,collectorId:'other'},'owner'),false);
});

test('pagamento após expiração compara valor devido no novo dia, não o QR antigo',()=>{
 const before=price(base({now:new Date('2026-11-07T23:50:00-03:00')}));
 assert.equal(before.totalCents,5110);
 assert.equal(requiredSettlementCents(before,new Date('2026-11-08T00:01:00-03:00')),5112);
 assert.equal(requiredSettlementCents(before,new Date('2026-11-07T23:59:59-03:00')),5110);
});
test('alterar configurações após a emissão não altera o montante congelado no snapshot',()=>{
 const original=price(base({now:day('2026-11-07')}));
 const newSettings={lateFeePct:0,interestMonthlyPct:0};
 assert.equal(price(base({settings:newSettings})).totalCents,5000);
 assert.equal(requiredSettlementCents(original,day('2026-11-07')),5110);
});
test('multa incide na base original mesmo com desconto manual; juros não incidem na multa',()=>{
 const q=price(base({planPriceCents:10001,oldPlanPriceCents:10001,
   manual:{type:'percent',value:50}}));
 assert.equal(q.baseCents,10001);
 assert.equal(q.manualDiscountCents,5001);
 assert.equal(q.lateFeeCents,200);
 assert.equal(q.interestCents,20);
 assert.equal(q.totalCents,5220);
});
test('mudança de dia obedece o calendário de São Paulo, não a data UTC',()=>{
 const due=new Date('2026-11-01T23:59:50-03:00');
 const after=new Date('2026-11-02T00:00:10-03:00');
 assert.equal(localDayDifference(due,after),1);
 assert.equal(localDayDifference(due,new Date('2026-11-01T23:59:59-03:00')),0);
 assert.equal(price(base({endsAt:due,now:after})).daysLate,1);
});
test('o limite de cobrança mínima também se aplica a desconto manual acumulado',()=>{
 const q=price(base({now:day('2026-10-01'),endsAt:day('2026-12-01'),effectiveStatus:'active',
  settings:{minChargeCents:1,earlyDiscountEnabled:true,earlyDiscountValue:99.99},
  manual:{type:'percent',value:100,stack:true}}));
 assert.equal(q.totalCents,1);
 assert.equal(q.earlyDiscountCents+q.manualDiscountCents,4999);
});
