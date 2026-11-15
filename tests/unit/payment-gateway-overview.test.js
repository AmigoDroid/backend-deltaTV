import test from 'node:test';
import assert from 'node:assert/strict';
import {safePublicOrigin,webhookCatalog} from '../../src/modules/payment-gateways/overview.js';

test('endereços públicos de webhook usam somente a origem da API',()=>{
  const rows=webhookCatalog('https://api.deltatv.com.br');
  assert.equal(rows.find(x=>x.id==='portal-infinitepay').url,'https://api.deltatv.com.br/api/v1/webhooks/portal-sales/infinitepay');
  assert.equal(rows.find(x=>x.id==='portal-mercadopago').url,'https://api.deltatv.com.br/api/v1/webhooks/portal-sales/mercadopago');
  assert.equal(rows.find(x=>x.id==='legacy-mercadopago').url,'https://api.deltatv.com.br/api/v1/webhooks/pix/mercadopago');
  assert.equal(rows.find(x=>x.id==='master-infinitepay').dynamic,true);
  assert.equal(rows.find(x=>x.id==='master-mercadopago').dynamic,true);
});
test('não expõe URL com usuário ou senha na origem pública',()=>{
  assert.equal(safePublicOrigin('https://token:senha@api.deltatv.com.br'),null);
  assert.equal(safePublicOrigin('javascript:alert(1)'),null);
  assert.equal(safePublicOrigin('ht#tp'),null);
  assert.equal(safePublicOrigin('https://api.deltatv.com.br:443/api?token=abc'),'https://api.deltatv.com.br');
});
