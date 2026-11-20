import test from 'node:test';
import assert from 'node:assert/strict';
import {createMercadoPago} from '../../src/modules/pix/providers/mercadopago.js';
import {createInfinitePay} from '../../src/modules/distribution/gateways/infinitepay.js';
import {inspectCreatingCharge} from '../../src/modules/network-finance/provider-lookup.js';
const id='11111111-1111-4111-8111-111111111111';
const charge=(provider,extras={})=>({id,method:'automatic',status:'creating',provider,amount_cents:5000,
  expires_at:'2099-01-01T03:00:00Z',...extras});
const credentials={accountRef:'123456',credential:'FAKE-ONLY'};
const response=data=>({ok:true,status:200,json:async()=>data});

test('Mercado Pago consulta por external_reference somente com GET e vincula id perdido',async()=>{
 const requests=[];
 const fakeFetch=async (url,options)=>{
  requests.push({url,method:options.method||'GET'});
  return response(url.includes('/search?')?{paging:{total:1},results:[{id:321,external_reference:id}]}:
   {id:321,status:'pending',external_reference:id,collector_id:'123456',transaction_amount:50,
    payment_method_id:'pix',currency_id:'BRL',point_of_interaction:{transaction_data:{qr_code:'qr-simulado'}}});
 };
 const api=()=>createMercadoPago({accessToken:'TOKEN-FALSO',fetchImpl:fakeFetch});
 const result=await inspectCreatingCharge(charge('mercadopago'),credentials,{mercadopago:api});
 assert.deepEqual(result,{kind:'pending',providerRef:'321',qrCode:'qr-simulado'});
 assert.equal(requests.length,2);
 assert.ok(requests.every(r=>r.method==='GET'));
 assert.match(requests[0].url,/external_reference=/);
 assert.ok(requests.every(r=>!r.url.includes('TOKEN-FALSO')));
});

test('Mercado Pago paga uma vez quando referencia, recebedor, Pix e valor conferem',async()=>{
 const api=()=>({searchByExternalReference:async()=>({ids:['321'],total:1}),getPayment:async()=>({
  providerRef:'321',status:'paid',externalReference:id,collectorId:'123456',currency:'BRL',
  paymentMethod:'pix',amountCents:5000})});
 assert.deepEqual(await inspectCreatingCharge(charge('mercadopago'),credentials,{mercadopago:api}),
   {kind:'paid',providerRef:'321',transactionNsu:null,slug:null,amountCents:5000});
});

test('Mercado Pago: pagamento a outro recebedor não liquida e duas referências vão para revisão',async()=>{
 const api=()=>({searchByExternalReference:async()=>({ids:['1'],total:1}),getPayment:async()=>({
  providerRef:'1',status:'paid',externalReference:id,collectorId:'999',currency:'BRL',
  paymentMethod:'pix',amountCents:5000})});
 assert.equal((await inspectCreatingCharge(charge('mercadopago'),credentials,{mercadopago:api})).kind,'review');
 const multiple=()=>({searchByExternalReference:async()=>({ids:['1','2'],total:2})});
 assert.deepEqual(await inspectCreatingCharge(charge('mercadopago'),credentials,{mercadopago:multiple}),
  {kind:'review',reason:'MULTIPLE_PROVIDER_PAYMENTS'});
});

test('InfinitePay sem slug/transaction_nsu não consulta apenas pelo order_nsu',async()=>{
 let called=false;
 const result=await inspectCreatingCharge(charge('infinitepay'),credentials,{infinitepay:()=>{called=true;throw Error('never');}});
 assert.equal(result.reason,'INFINITEPAY_IDENTIFIERS_MISSING');
 assert.equal(called,false);
});

test('InfinitePay payment_check read-only exige Pix e paid_amount em centavos',async()=>{
 const calls=[];
 const infinitepay=()=>createInfinitePay({handle:'123456',apiKey:'TEST-KEY',fetchImpl:async (url,options)=>{
  calls.push({url,method:options.method,body:JSON.parse(options.body)});
  return response({success:true,paid:true,capture_method:'pix',paid_amount:5000,amount:5000});
 }});
 const c=charge('infinitepay',{transaction_nsu:'tx-1',payment_slug:'slug-1'});
 const value=await inspectCreatingCharge(c,credentials,{infinitepay});
 assert.equal(value.kind,'paid');
 assert.equal(value.amountCents,5000);
 assert.equal(calls.length,1);
 assert.match(calls[0].url,/\/payment_check$/);
 assert.equal(calls[0].body.order_nsu,id);
 assert.equal(calls[0].method,'POST');
 const wrong=()=>({paymentCheck:async()=>({paid:true,captureMethod:'credit_card',paidAmountCents:5000})});
 assert.equal((await inspectCreatingCharge(c,credentials,{infinitepay:wrong})).kind,'review');
});
