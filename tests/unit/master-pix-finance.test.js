import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {totalCents,verifyPaymentMatch,canDeliver,isSettled,reserveCanRelease} from '../../src/modules/distribution/master-pix.policy.js';
import {createMercadoPago,verifySignature,mapStatus} from '../../src/modules/pix/providers/mercadopago.js';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const order={id,provider_ref:'123456',total_cents:'2250',status:'pending',fulfilled_at:null,released_at:null};
const pay={providerRef:'123456',externalReference:id,amountCents:2250,collectorId:'987',paymentMethod:'pix',currency:'BRL',status:'paid'};
test('valor em centavos: precisão e rejeição de quantidade/overflow',()=>{
 assert.equal(totalCents(750,3),2250);
 assert.equal(totalCents(1,1),1);
 assert.equal(totalCents(100,0),null);
 assert.equal(totalCents(0,1),null);
 assert.equal(totalCents(-5,1),null);
 assert.equal(totalCents(1.5,1),null);
 assert.equal(totalCents(100,1.5),null);
 assert.equal(totalCents(Number.MAX_SAFE_INTEGER,100),null);
 assert.equal(totalCents(100,2_147_483_648),null);
});
test('pagamento válido: conta MP correta, moeda BRL, Pix, valor e referência externa',()=>{
 assert.equal(verifyPaymentMatch(order,pay,'987'),true);
});
for(const [description,patch] of [
 ['valor divergente',{amountCents:2200}],
 ['pagamento de outra compra',{externalReference:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}],
 ['pagamento de outro Master',{collectorId:'123'}],
 ['identificador de pagamento divergente',{providerRef:'222'}],
 ['não é Pix',{paymentMethod:'credit_card'}],
 ['moeda incorreta',{currency:'USD'}],
 ['não identifica o recebedor',{collectorId:null}],
])test(`fraude bloqueada: ${description}`,()=>assert.equal(verifyPaymentMatch(order,{...pay,...patch},'987'),false));
test('não valida cobrança sem referência associada',()=>assert.equal(verifyPaymentMatch({...order,provider_ref:null},pay,'987'),false));
test('entrega exige vínculo, contas ativas e reserva não devolvida',()=>{
 const buyer={status:'active',parentPartnerId:'seller'},seller={id:'seller',status:'active',distributionRole:'master'};
 assert.equal(canDeliver(order,buyer,seller),true);
 assert.equal(canDeliver({...order,fulfilled_at:new Date()},buyer,seller),false);
 assert.equal(canDeliver({...order,released_at:new Date()},buyer,seller),false);
 assert.equal(canDeliver(order,{...buyer,parentPartnerId:'other'},seller),false);
 assert.equal(canDeliver(order,{...buyer,status:'suspended'},seller),false);
 assert.equal(canDeliver(order,buyer,{...seller,distributionRole:'reseller'}),false);
});
test('não devolver estoque por um pagamento ainda pendente',()=>{
 assert.equal(isSettled('paid'),true);
 assert.equal(reserveCanRelease('pending'),false);
 assert.equal(reserveCanRelease('paid'),false);
 assert.equal(reserveCanRelease('cancelled'),true);
 assert.equal(reserveCanRelease('refunded'),true);
});
test('Mercado Pago: cria cobrança na conta do Master com idempotência e valor exato',async()=>{
 const requests=[];
 const fetchImpl=async(url,opt)=>{
  requests.push({url,opt});
  return {ok:true,json:async()=>({id:123456,date_of_expiration:'2026-11-13T22:00:00-03:00',
    point_of_interaction:{transaction_data:{qr_code:'000201...'}}})};
 };
 const p=createMercadoPago({accessToken:'SINGLE_MASTER_TOKEN',fetchImpl});
 const c=await p.createCharge({id,amountCents:2250,description:'Teste',
   payer:{email:'revenda@example.com',document:'12345678901'},expiresAt:new Date('2026-11-14T01:00:00Z'),notificationUrl:'https://api.deltatv.com.br/webhook'});
 assert.equal(c.providerRef,'123456');assert.equal(c.qrCode,'000201...');
 assert.equal(requests.length,1);
 assert.equal(requests[0].opt.headers.Authorization,'Bearer SINGLE_MASTER_TOKEN');
 assert.equal(requests[0].opt.headers['X-Idempotency-Key'],id);
 const body=JSON.parse(requests[0].opt.body);
 assert.equal(body.transaction_amount,22.5);
 assert.equal(body.external_reference,id);
 assert.equal(body.payment_method_id,'pix');
 assert.equal(body.payer.identification.type,'CPF');
});
test('Mercado Pago: consulta confirma destinatário sem confiar em webhook',async()=>{
 const p=createMercadoPago({accessToken:'OTHER_MASTER',fetchImpl:async()=>({ok:true,json:async()=>({id:'123456',status:'approved',
   payment_method_id:'pix',currency_id:'BRL',collector_id:987,transaction_amount:22.5,external_reference:id})})});
 assert.deepEqual(await p.getPayment('123456'),{
   providerRef:'123456',status:'paid',rawStatus:'approved',amountCents:2250,externalReference:id,
   collectorId:'987',paymentMethod:'pix',currency:'BRL',refundedAmountCents:0,paidAt:null});
});
test('webhook sem assinatura ou assinatura trocada é recusado',()=>{
 const secret='test-webhook-secret'; const dataId='123456',requestId='abc';const ts='1794600000000';
 const message=`id:${dataId};request-id:${requestId};ts:${ts};`;
 const sig=crypto.createHmac('sha256',secret).update(message).digest('hex');
 assert.equal(verifySignature({secret,signatureHeader:`ts=${ts},v1=${sig}`,requestId,dataId}),true);
 assert.equal(verifySignature({secret,signatureHeader:`ts=${ts},v1=${sig}`,requestId,dataId:'999'}),false);
 assert.equal(verifySignature({secret,signatureHeader:null,requestId,dataId}),false);
 assert.equal(verifySignature({secret:'',signatureHeader:`ts=${ts},v1=${sig}`,requestId,dataId}),false);
});
test('status do provedor é mapeado sem false positive',()=>{
 assert.equal(mapStatus('approved'),'paid');assert.equal(mapStatus('rejected'),'cancelled');
 assert.equal(mapStatus('refunded'),'refunded');assert.equal(mapStatus('pending'),'pending');
});
