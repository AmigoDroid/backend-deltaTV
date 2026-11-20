import test from 'node:test';
import assert from 'node:assert/strict';
import {isNetworkRenewalOnlyPartner,isNetworkPortalAccessible} from '../../src/modules/network-finance/renewal-only-access.js';
const last=new Date('2020-11-01T00:00:00Z');
const past={status:'active',ownerAdminId:'admin-a',endsAt:last};
test('parceiro vencido de rede administrada tem acesso somente à renovação',()=>{
 assert.equal(isNetworkRenewalOnlyPartner(past),true);
 assert.equal(isNetworkPortalAccessible(past,'content_partner'),true);
 assert.equal(isNetworkPortalAccessible(past,'partner'),false);
 assert.equal(isNetworkPortalAccessible(past,'admin'),false);
});
test('bloqueio, suspensão e contas antigas não ganham exceção',()=>{
 for(const variant of [{status:'blocked'},{status:'suspended'},{status:'cancelled'},{ownerAdminId:null}]){
  const x={...past,...variant};assert.equal(isNetworkRenewalOnlyPartner(x),false);
  assert.equal(isNetworkPortalAccessible(x,'content_partner'),false);
 }
 assert.equal(isNetworkPortalAccessible(null,'content_partner'),false);
});
test('parceiro ativo continua com acesso normal',()=>{
 const active={...past,endsAt:new Date('2100-12-01T00:00:00Z')};
 assert.equal(isNetworkRenewalOnlyPartner(active),false);
 assert.equal(isNetworkPortalAccessible(active,'content_partner'),true);
 assert.equal(isNetworkPortalAccessible(active,'partner'),true);
});
