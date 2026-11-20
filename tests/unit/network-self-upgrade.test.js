import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isSelfServiceUpgrade,hasCustomPlanOverrides,upgradePlanSignature,upgradePriceBaseline} from '../../src/modules/network-finance/upgrade-eligibility.js';

const starter={key:'starter',active:true,deletedAt:null,hiddenFromNetwork:false,monthlyPriceCents:5000,
  maxServers:2,activationLimit:10,validityDays:30,autoFailover:false,autoPriority:false,
  emailAlerts:false,detailedHistory:false,canResellPanel:false,canCreateSubmasters:false,
  canViewFinance:false,canManageGateways:false};
const premium={...starter,key:'premium',monthlyPriceCents:8000,maxServers:4,activationLimit:20,autoFailover:true};
const src=path=>readFileSync(new URL(`../../src/${path}`,import.meta.url),'utf8');
test('upgrade depende apenas do preço superior e da publicação do plano',()=>{
 assert.equal(isSelfServiceUpgrade(starter,premium),true);
 assert.equal(isSelfServiceUpgrade(premium,starter),false);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,monthlyPriceCents:5000}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,monthlyPriceCents:4999}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,maxServers:1}),true);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,activationLimit:9}),true);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,validityDays:20}),true);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,hiddenFromNetwork:true}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,active:false}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...premium,deletedAt:new Date()}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...starter}),false);
});
test('plano de R$ 15.000 é upgrade por preço, mesmo com diferenças de recursos',()=>{
 const target={...premium,key:'upgrade-15000',monthlyPriceCents:1500000,maxServers:1,
  activationLimit:5,validityDays:15,autoFailover:false,canResellPanel:true};
 assert.equal(isSelfServiceUpgrade(starter,target),true);
 assert.equal(isSelfServiceUpgrade({...starter,maxServers:null,autoFailover:true,canResellPanel:true},target),true);
 assert.equal(isSelfServiceUpgrade(starter,{...target,monthlyPriceCents:NaN}),false);
 assert.equal(isSelfServiceUpgrade(starter,{...target,monthlyPriceCents:1500000.5}),false);
 assert.equal(isSelfServiceUpgrade({...starter,monthlyPriceCents:1500000},target),false);
});
test('mudança de preço ou recurso invalida condições congeladas da cobrança',()=>{
 const digest=upgradePlanSignature(premium);
 assert.equal(digest.length,64);
 assert.notEqual(digest,upgradePlanSignature({...premium,monthlyPriceCents:9000}));
 assert.notEqual(digest,upgradePlanSignature({...premium,activationLimit:30}));
 assert.equal(digest,upgradePlanSignature({...premium}));
});
test('parceiro não fornece identidade, valor, desconto nem gateway na API',()=>{
 const routes=src('modules/network-finance/finance.routes.js');
 const service=src('modules/network-finance/finance.service.js');
 const pricing=src('modules/network-finance/pricing.service.js');
 assert.match(routes,/upgradeChoice=z\.object\(\{planTo:/);
 assert.match(routes,/pricing\.quotePartnerUpgrade\(req\.user\.partnerId/);
 assert.match(routes,/svc\.createPartnerUpgradeCharge\(req\.user\.partnerId/);
 assert.match(service,/method:'automatic'\},actor,\{source:'partner'\}/);
 assert.match(service,/selfServiceUpgrade===true/);
 assert.match(service,/upgradePlanSignature!==upgradePlanSignature/);
 assert.match(pricing,/source==='partner'&&kind==='upgrade'&&!isSelfServiceUpgrade/);
 assert.match(routes,/partnerNetworkCharges\.post\(\['\/','\/preview'\]/);
});
test('Master consulta apenas telefone do perfil da conta proprietária e não credenciais',()=>{
 const service=src('modules/network-finance/finance.service.js');
 assert.match(service,/getPartnerMasterContact\(partnerId\)/);
 assert.match(service,/id:partner\.ownerAdminId,role:'admin'/);
 assert.match(service,/AdminUserProfile\.findByPk\(master\.id,\{attributes:\['phone'\]/);
});

test('personalizações de recursos obrigam contato com o Master',()=>{
 assert.equal(hasCustomPlanOverrides({maxServersOverride:2},starter),false);
 assert.equal(hasCustomPlanOverrides({maxServersOverride:null,autoFailoverOverride:null},starter),false);
 assert.equal(hasCustomPlanOverrides({maxServersOverride:10},starter),true);
 assert.equal(hasCustomPlanOverrides({autoFailoverOverride:true},starter),true);
});

test('contrato ilimitado gratuito, mesmo legado sem catálogo do Master, pode comprar plano de R$ 16.000',()=>{
 const contract={billingModel:'fixed',monthlyFeeCents:0};
 const assignment={tier:'partner_professional',maxServersOverride:null};
 const base=upgradePriceBaseline(contract,assignment,null);
 const paid={...premium,key:'ilimitado-16000',monthlyPriceCents:1600000,maxServers:null,activationLimit:null};
 assert.equal(base.monthlyPriceCents,0);
 assert.equal(base.key,assignment.tier);
 assert.equal(isSelfServiceUpgrade(base,paid),true);
 assert.equal(isSelfServiceUpgrade(base,{...paid,monthlyPriceCents:0}),false);
 assert.equal(isSelfServiceUpgrade(base,{...paid,hiddenFromNetwork:true}),false);
 // O preço efetivamente contratado, não o preço de tabela, decide o upgrade.
 assert.equal(upgradePriceBaseline(contract,assignment,{...premium,monthlyPriceCents:2000000}).monthlyPriceCents,0);
 assert.equal(isSelfServiceUpgrade(upgradePriceBaseline(contract,assignment,{...premium,monthlyPriceCents:2000000}),paid),true);
});
test('contrato pago legado sem catálogo não tem preço confiável: não liberar cobrança',()=>{
 assert.equal(upgradePriceBaseline({billingModel:'fixed',monthlyFeeCents:5000},{tier:'legacy'},null),null);
 assert.equal(upgradePriceBaseline({billingModel:'credits',monthlyFeeCents:0},{tier:'legacy'},null),null);
 assert.equal(upgradePriceBaseline({billingModel:'fixed',monthlyFeeCents:0},null,null).monthlyPriceCents,0);
});
test('catálogo, prévia e liquidação usam a mesma base gratuita e preservam validação do pagamento',()=>{
 const pricing=src('modules/network-finance/pricing.service.js');
 const settlement=src('modules/network-finance/finance.service.js');
 assert.match(pricing,/const baseline=upgradePriceBaseline\(partner,service,current\)/);
 assert.match(pricing,/const baseline=kind==='upgrade'\?upgradePriceBaseline\(partner,current,old\)/);
 assert.match(pricing,/oldPlanPriceCents:kind==='upgrade'\?baseline\.monthlyPriceCents/);
 assert.match(settlement,/upgradePriceBaseline\(partner,current,original\)/);
 assert.match(settlement,/baseline\.monthlyPriceCents!==charge\.breakdown\.oldPlanPriceCents/);
 assert.match(settlement,/upgradePlanSignature!==upgradePlanSignature/);
 assert.match(settlement,/PROVIDER_CONFIRMATION_REQUIRED/);
});
