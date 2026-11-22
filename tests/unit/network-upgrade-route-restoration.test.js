import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=path=>readFileSync(new URL(`../../src/${path}`,import.meta.url),'utf8');
test('Meu Plano possui rotas autenticadas de catálogo, prévia e geração de cobrança',()=>{
 const mount=source('modules/portal/portal.routes.js');
 const routes=source('modules/network-finance/finance.routes.js');
 assert.match(mount,/router\.use\(\"\/network-charges\",partnerNetworkCharges\)/);
 for(const [method,route] of [['get','upgrade-options'],['post','upgrade/preview'],['post','upgrade'],['get','master']])
  assert.ok(routes.includes(`partnerNetworkCharges.${method}('/${route}'`),`Falta ${method} /${route}`);
 assert.match(routes,/req\.user\.partnerId/);
 assert.match(routes,/req\.impersonator/);
});
test('cobrança emitida só por backend usa preço integral e gateway do Master',()=>{
 const finance=source('modules/network-finance/finance.service.js');
 const pricing=source('modules/network-finance/pricing.service.js');
 assert.match(finance,/createPartnerUpgradeCharge\(partnerId/);
 assert.match(finance,/method:'automatic'\},actor,\{source:'partner'\}/);
 assert.match(finance,/PROVIDER_CONFIRMATION_REQUIRED/);
 assert.match(pricing,/fullUpgradePrice:source==='partner'&&kind==='upgrade'/);
 assert.match(finance,/upgradePlanSignature!==upgradePlanSignature/);
});
