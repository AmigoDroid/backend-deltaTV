import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createInfinitePay} from '../../src/modules/distribution/gateways/infinitepay.js';
import {verifyNetworkPaymentMatch} from '../../src/modules/network-finance/policy.js';

const require=createRequire(import.meta.url);
const migration=require('../../src/db/migrations/20270112000001-network-charge-recovery.cjs');

test('migration de recuperação tem up/down reversíveis e índice parcial',async()=>{
 const sql=[];
 const q={sequelize:{transaction:fn=>fn({test:true}),query:async statement=>{sql.push(statement);}}};
 await migration.up(q);
 await migration.down(q);
 assert.match(sql[0],/ADD COLUMN recovery_attempts/);
 assert.match(sql[0],/WHERE status='creating'/);
 assert.match(sql[1],/DROP COLUMN recovery_checked_at/);
 assert.match(sql[1],/DROP COLUMN recovery_attempts/);
});

test('a InfinitePay sem capture_method e valor provado não satisfaz a verificação Pix',async()=>{
 const p=createInfinitePay({handle:'conta-teste',apiKey:'chave-falsa-local',fetchImpl:async()=>({
  ok:true,status:200,json:async()=>({success:true,paid:true})})});
 const v=await p.paymentCheck({orderNsu:'pedido',transactionNsu:'tx',slug:'sl'});
 assert.equal(v.paid,true);
 assert.equal(v.captureMethod,null);
 const charge={id:'pedido',amount_cents:5000};
 const receipt={confirmed:true,externalReference:'pedido',currency:'BRL',paymentMethod:v.captureMethod,
  amountCents:v.paidAmountCents??v.amountCents,collectorId:'conta-teste'};
 assert.equal(verifyNetworkPaymentMatch(charge,receipt,'conta-teste'),false);
});

test('Pix da InfinitePay: método comprovado e valor integral são obrigatórios',async()=>{
 const p=createInfinitePay({handle:'conta-teste',fetchImpl:async()=>({
  ok:true,status:200,json:async()=>({success:true,paid:true,capture_method:'pix',paid_amount:5000})})});
 const v=await p.paymentCheck({orderNsu:'pedido',transactionNsu:'tx',slug:'sl'});
 const c={id:'pedido',amount_cents:5000};
 const receipt={confirmed:true,externalReference:'pedido',currency:'BRL',paymentMethod:v.captureMethod,
   amountCents:v.paidAmountCents,collectorId:'conta-teste'};
 assert.equal(verifyNetworkPaymentMatch(c,receipt,'conta-teste'),true);
 assert.equal(verifyNetworkPaymentMatch(c,{...receipt,amountCents:4999},'conta-teste'),false);
});

test('a rotina de recuperação usa SKIP LOCKED e não dá baixa financeira automática',()=>{
 const service=readFileSync(new URL('../../src/modules/network-finance/finance.service.js',import.meta.url),'utf8');
 const block=service.slice(service.indexOf('export async function recoverStaleCreatingCharges'));
 assert.match(block,/FOR UPDATE SKIP LOCKED/);
 assert.match(block,/THEN 'needs_review'/);
 assert.doesNotMatch(block,/status='paid'/);
 assert.match(block,/maxAttempts/);
});
