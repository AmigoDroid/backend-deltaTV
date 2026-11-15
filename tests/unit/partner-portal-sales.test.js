import test from 'node:test';
import assert from 'node:assert/strict';
import {addMonthsUtc,allowedChildRole,isContentPartner,resaleAllowed,safeTotal} from '../../src/modules/partner-portal-sales/sales.rules.js';

test('somente parceiros de conteúdo podem participar da venda do painel',()=>{
 assert.equal(isContentPartner('reseller'),false);
 assert.equal(isContentPartner('content'),true);
 assert.equal(isContentPartner('both'),true);
});
test('Master raiz e Submaster seguem a hierarquia do portal, não da revenda',()=>{
 assert.equal(allowedChildRole(null),'master');
 assert.equal(allowedChildRole('any-parent-id'),'submaster');
});
test('preço mínimo comercial nunca aceita venda abaixo do piso',()=>{
 const plan={min_resale_cents:1200};
 assert.equal(resaleAllowed(1199,plan),false);
 assert.equal(resaleAllowed(1200,plan),true);
 assert.equal(resaleAllowed(-1,plan),false);
 assert.equal(resaleAllowed(0,plan,{exception:true}),true);
});
test('centavos inteiros impedem erros de ponto flutuante e overflow',()=>{
 assert.equal(safeTotal(799,12),9588);
 assert.throws(()=>safeTotal(1.5,2));
 assert.throws(()=>safeTotal(200,0));
 assert.throws(()=>safeTotal(Number.MAX_SAFE_INTEGER,2));
});
test('prazo mensal usa UTC e preserva dia quando viável',()=>{
 assert.equal(addMonthsUtc('2026-01-31T10:25:00Z',1).toISOString(),'2026-02-28T10:25:00.000Z');
 assert.equal(addMonthsUtc('2024-01-31T10:25:00Z',1).toISOString(),'2024-02-29T10:25:00.000Z');
 assert.equal(addMonthsUtc('2026-10-15T00:00:00Z',3).toISOString(),'2027-01-15T00:00:00.000Z');
 assert.throws(()=>addMonthsUtc(new Date(),0));
});

test('custo fixo da VPS e domínio anual gera base previsível',async()=>{
 const {forecastMonthlyCost}=await import('../../src/modules/partner-portal-sales/sales.rules.js');
 const f=forecastMonthlyCost({vps_monthly_cents:3000,domain_annual_cents:4000,other_monthly_cents:0,proxy_cost_per_gb_cents:0,forecast_proxy_gb_per_partner:0,target_margin_bp:2500,tax_bp:0,reserve_bp:1000},10);
 assert.equal(f.activePartners,10);
 assert.equal(f.monthlyFixedCents,3333);
 assert.equal(f.estimatedCostPerPartnerCents,334);
 assert.ok(f.suggestedWholesaleCents>f.estimatedCostPerPartnerCents);
});
test('custo de proxy previsto impacta preço recomendado; isso não é medição real',async()=>{
 const {forecastMonthlyCost}=await import('../../src/modules/partner-portal-sales/sales.rules.js');
 const f=forecastMonthlyCost({vps_monthly_cents:3000,domain_annual_cents:4000,other_monthly_cents:0,proxy_cost_per_gb_cents:10,forecast_proxy_gb_per_partner:100,target_margin_bp:2000,tax_bp:0,reserve_bp:1000},10);
 assert.equal(f.forecastProxyCents,10000);
 assert.ok(f.suggestedWholesaleCents>f.estimatedCostPerPartnerCents);
 assert.throws(()=>forecastMonthlyCost({vps_monthly_cents:0,domain_annual_cents:0,other_monthly_cents:0,proxy_cost_per_gb_cents:0,forecast_proxy_gb_per_partner:0,target_margin_bp:8000,tax_bp:2000,reserve_bp:0},1));
});
