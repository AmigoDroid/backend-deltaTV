import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root=new URL('../../src/modules/distribution/',import.meta.url);
const text=file=>readFileSync(new URL(file,root),'utf8');

test('a entrega somente usa estoque de licenças e exige revenda direta',()=>{
 const s=text('master-license-delivery.service.js');
 assert.match(s,/buyer\.parentPartnerId\s*!==\s*sellerId/);
 assert.match(s,/requireMaster\(sellerId,'canSell'/);
 assert.match(s,/stockMove\(transaction/);
 assert.match(s,/delta:-quantity/);
 assert.match(s,/delta:quantity/);
});
test('nenhuma entrega manual confirma Pix ou cria créditos fictícios',()=>{
 const s=text('master-license-delivery.service.js');
 assert.doesNotMatch(s,/creditMove|reconcileOrder|settleNetworkCommissions/);
 assert.match(s,/paymentVerifiedByPlatform:false/);
});
test('a entrega grava auditoria e evita duplicidade',()=>{
 const s=text('master-license-delivery.service.js');
 assert.match(s,/pg_advisory_xact_lock/);
 assert.match(s,/idempotency_key/);
 assert.match(s,/action:'distribution\.license_delivery'/);
});
test('a rota administrativa permite supervisionar entregas',()=>{
 const r=text('network.routes.js');
 assert.match(r,/accounts\/:id\/license-deliveries/);
 assert.match(r,/req\.user\.role!=="superadmin"/);
 assert.match(r,/partnerNetwork\.post\("\/license-deliveries"/);
});
