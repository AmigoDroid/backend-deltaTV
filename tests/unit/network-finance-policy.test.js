import test from 'node:test';
import assert from 'node:assert/strict';
import {canActivateGateway,csvSafe,fingerprint,maskAccountRef,CHARGE_STATUSES,PROVIDERS} from '../../src/modules/network-finance/policy.js';

const valid = {provider:'mercadopago',credential:'APP_USR-fake-only-test',secret:'test-signing',accountRef:'pending'};
test('provedor de cobrança é imutável; lista não inclui carteira DeltaTV',()=>{
 assert.deepEqual(PROVIDERS,['mercadopago','infinitepay']);
 assert.equal(PROVIDERS.includes('deltatv'),false);
 assert.ok(CHARGE_STATUSES.includes('review'));
});
test('ativação só passa após teste válido das credenciais atuais',()=>{
 const current=fingerprint(valid), old=fingerprint({...valid,credential:'other'});
 const row={credential_fingerprint:current,tested_fingerprint:old,tested_at:new Date()};
 assert.equal(canActivateGateway(row),false);
 assert.equal(canActivateGateway({...row,tested_fingerprint:current}),true);
 assert.equal(canActivateGateway({...row,tested_fingerprint:current,tested_at:new Date(Date.now()-25*3600_000)}),false);
 assert.equal(canActivateGateway(null),false);
});
test('superadmin recebe apenas referência mascarada',()=>{
 assert.equal(maskAccountRef('123456789011'),'********9011');
 assert.equal(maskAccountRef(null),null);
 assert.equal(maskAccountRef('ab'),'**');
});
test('CSV não executa fórmulas e não contém quebra de linha injetada',()=>{
 assert.equal(csvSafe('=cmd|x'),'"\'=cmd|x"');
 assert.equal(csvSafe(' +SUM(1,1)'),'"\' +SUM(1,1)"');
 assert.equal(csvSafe('nome\r\n="x"'),'"nome =""x"""');
});
