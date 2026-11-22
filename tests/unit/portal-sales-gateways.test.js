import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {providerAvailable,isCheckoutDomain,verifiedAmountMatches,postgresMigrationError} from '../../src/modules/partner-portal-sales/checkout.rules.js';
import {createInfinitePay} from '../../src/modules/distribution/gateways/infinitepay.js';
const source=path=>readFileSync(new URL(path,import.meta.url),'utf8');
test('gateway manual sempre funciona; gateway automático exige credenciais server-side',()=>{
 assert.equal(providerAvailable('manual',{}),true);
 assert.equal(providerAvailable('infinitepay',{}),false);
 assert.equal(providerAvailable('infinitepay',{infinitepayApiKey:'inchk_key'}),false);
 assert.equal(providerAvailable('infinitepay',{infinitepayHandle:'deltatv'}),true);
 assert.equal(providerAvailable('infinitepay',{infinitepayHandle:'deltatv',infinitepayApiKey:'inchk_key'}),true);
 assert.equal(providerAvailable('mercadopago',{mpAccessToken:'tok'}),false);
 assert.equal(providerAvailable('mercadopago',{mpAccessToken:'tok',mpWebhookSecret:'secret'}),true);
});
test('comparação financeira rejeita pagamentos com valor diferente',()=>{
 assert.equal(verifiedAmountMatches({total_cents:'1000'},1000),true);
 assert.equal(verifiedAmountMatches({total_cents:'1000'},999),false);
 assert.equal(verifiedAmountMatches({total_cents:'1000'},null),false);
});
test('links somente sob host seguro do provedor',()=>{
 assert.equal(isCheckoutDomain('https://link.infinitepay.io/test'),true);
 assert.equal(isCheckoutDomain('https://infinitepay.io.evil.site/'),false);
 assert.equal(isCheckoutDomain('http://infinitepay.io/'),false);
});
test('erro de migração PostgreSQL não deve vazar query nem credenciais',()=>{
 assert.equal(postgresMigrationError({parent:{code:'42P01'}}),true);
 assert.equal(postgresMigrationError({original:{code:'42703'}}),true);
 assert.equal(postgresMigrationError({parent:{code:'23505'}}),false);
});
test('InfinitePay cria checkout com single_payment e valida resultado exclusivamente via payment_check',async()=>{
 const requests=[];
 const fakeFetch=async (url,opts)=>{
  requests.push({url,headers:opts.headers,body:JSON.parse(opts.body)});
  return {ok:true,status:200,json:async()=>url.endsWith('/links')?{url:'https://link.infinitepay.io/pay/123'}:
    {success:true,paid:true,amount:1500,paid_amount:1520,capture_method:'pix'}};
 };
 const adapter=createInfinitePay({handle:'deltatv',apiKey:'inchk_FAKE',fetchImpl:fakeFetch});
 const expires=new Date(Date.now()+3_600_000);
 const link=await adapter.createLink({orderNsu:'ord1',amountCents:1500,description:'Plano',validUntil:expires,
  singlePayment:true,redirectUrl:'https://parceiro.deltatv.com.br/',webhookUrl:'https://api.deltatv.com.br/webhook'});
 assert.match(link.url,/^https:/);
 assert.equal(requests[0].body.options.single_payment,true);
 assert.equal(requests[0].headers['X-Api-Key'],'inchk_FAKE');
 const verified=await adapter.paymentCheck({orderNsu:'ord1',transactionNsu:'tx1',slug:'slug1'});
 assert.equal(verified.paid,true);assert.equal(verified.amountCents,1500);
 assert.equal(requests[1].url,'https://api.checkout.infinitepay.io/payment_check');
});
test('migração e rotas preservam compras antigas e isolam o estoque do Painel do Parceiro',()=>{
 const migration=source('../../src/db/migrations/20261224000001-partner-portal-payment-checkout.cjs');
 const routes=source('../../src/modules/partner-portal-sales/sales.routes.js');
 const service=source('../../src/modules/partner-portal-sales/sales.service.js');
 assert.match(migration,/DEFAULT 'manual'/);
 assert.doesNotMatch(migration,/DROP TABLE|TRUNCATE|UPDATE\s+licenses|UPDATE\s+activations/i);
 assert.match(routes,/portalSalesWebhook/);
 assert.match(service,/GATEWAY_VERIFICATION_REQUIRED/);
 assert.match(service,/payment_verified_at=now\(\)/);
 assert.match(service,/PORTAL_SALES_MIGRATION_REQUIRED/);
});
test('InfinitePay só com InfiniteTag: chave opcional nas rotas e serviços, obrigatória no Mercado Pago',()=>{
 const sales=source('../../src/modules/partner-portal-sales/sales.routes.js');
 const v2=source('../../src/modules/partner-portal-sales/commercial-v2.service.js');
 const fin=source('../../src/modules/network-finance/finance.routes.js');
 const finSvc=source('../../src/modules/network-finance/finance.service.js');
 assert.match(sales,/accessToken:z\.union\(\[z\.literal\(''\),z\.string\(\)\.trim\(\)\.min\(12\)\.max\(1000\)\]\)\.optional\(\)/);
 assert.match(sales,/v\.provider!=='mercadopago'\|\|Boolean\(v\.accessToken\)/);
 assert.match(v2,/provider==='mercadopago'&&!accessToken\)fail\(422/);
 assert.match(v2,/accessToken:accessToken\|\|''/);
 assert.match(fin,/apiKey:z\.union\(\[z\.literal\(''\),z\.string\(\)\.trim\(\)\.min\(14\)\.max\(250\)\]\)\.optional\(\)/);
 assert.match(finSvc,/input\.apiKey\|\|''/);
 assert.match(finSvc,/\(credential&&!\/\^inchk_/);
});
test('InfinitePay sem chave: link sem options e sem X-Api-Key, confirmação continua só por payment_check',async()=>{
 const calls=[];
 const fakeFetch=async(url,init)=>{calls.push({url,headers:init.headers,body:JSON.parse(init.body)});
  return {ok:true,status:200,json:async()=>url.endsWith('/links')?{url:'https://checkout.infinitepay.io/x'}:{success:true,paid:true,amount:2500,paid_amount:2500,capture_method:'pix'}};};
 const adapter=createInfinitePay({handle:'deltatv',apiKey:'',fetchImpl:fakeFetch});
 await adapter.createLink({orderNsu:'o-1',amountCents:2500,description:'x',redirectUrl:'https://r.example/',webhookUrl:'https://api.example/w',validUntil:new Date(Date.now()+60000),singlePayment:true});
 assert.equal(calls[0].headers['X-Api-Key'],undefined);
 assert.equal(calls[0].body.options,undefined);
 assert.equal(calls[0].body.handle,'deltatv');
 const check=await adapter.paymentCheck({orderNsu:'o-1',transactionNsu:'t-1',slug:'s-1'});
 assert.equal(check.paid,true);
 assert.equal(calls[1].headers['X-Api-Key'],undefined);
 assert.deepEqual(Object.keys(calls[1].body).sort(),['handle','order_nsu','slug','transaction_nsu']);
});
