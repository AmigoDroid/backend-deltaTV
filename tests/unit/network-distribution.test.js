import test from "node:test";
import assert from "node:assert/strict";
import { MAX_NETWORK_QUANTITY, resellerKind, isNetworkMaster, networkPrice, canUseInvite, deriveNetworkLabel, purchaseLegs } from "../../src/modules/distribution/network.policy.js";

test("conta antiga continua como revenda e não vira master",()=>{
 assert.equal(resellerKind("reseller"),true);
 assert.equal(resellerKind("content"),false);
 assert.equal(isNetworkMaster({distributionRole:"reseller",kind:"reseller"}),false);
 assert.equal(isNetworkMaster({distributionRole:"master",kind:"reseller"}),true);
 assert.equal(isNetworkMaster({distributionRole:"master",kind:"content"}),false);
});
test("distingue Master, Submaster e Revenda pelo relacionamento",()=>{
 assert.equal(deriveNetworkLabel("master",0),"Master");
 assert.equal(deriveNetworkLabel("master",2),"Submaster");
 assert.equal(deriveNetworkLabel("reseller",3),"Revenda");
});
test("preço exato, sem arredondamento de crédito nem quantidade inválida",()=>{
 assert.equal(networkPrice(10,5),50);
 assert.equal(networkPrice(1,MAX_NETWORK_QUANTITY),MAX_NETWORK_QUANTITY);
 assert.equal(networkPrice(10,1000),10000);
 for(const [u,q] of [[-1,5],[0,5],[10,0],[10,-1],[2,MAX_NETWORK_QUANTITY+1],[1.5,2],[1,2.5],[2_147_483_648,1]])
  assert.equal(networkPrice(u,q),null);
});
test("venda é bilateral e conserva saldo de créditos e estoque",()=>{
 const legs=purchaseLegs({buyerId:"a",sellerId:"b",months:12,quantity:6,total:42});
 assert.equal(legs.credits.reduce((sum,l)=>sum+l.delta,0),0);
 assert.equal(legs.stock.reduce((sum,l)=>sum+l.delta,0),0);
 assert.deepEqual(legs.credits.map(l=>l.id),["a","b"]);
 assert.deepEqual(legs.stock.map(l=>l.id),["a","b"]);
});
test("mesmo titular não pode vender para si",()=>{
 assert.equal(purchaseLegs({buyerId:"a",sellerId:"a",months:12,quantity:3,total:30}),null);
});
test("convite respeita validade, bloqueio e quantidade",()=>{
 const now=Date.UTC(2026,10,13);
 const base={expires_at:new Date(now+60_000),uses:0,max_uses:5,revoked_at:null};
 assert.equal(canUseInvite(base,now),true);
 assert.equal(canUseInvite({...base,uses:5},now),false);
 assert.equal(canUseInvite({...base,revoked_at:new Date(now)},now),false);
 assert.equal(canUseInvite({...base,expires_at:new Date(now)},now),false);
 assert.equal(canUseInvite(null,now),false);
});
test("convites sem quota ou vencimento continuam válidos até revogação",()=>{
 const base={expires_at:null,max_uses:null,uses:12000,revoked_at:null};
 assert.equal(canUseInvite(base),true);
 assert.equal(canUseInvite({...base,revoked_at:new Date()}),false);
 assert.equal(canUseInvite({...base,max_uses:12000}),false);
 assert.equal(canUseInvite({...base,expires_at:new Date(0)}),false);
});

test("zero servidores é limite zero e não ilimitado",async()=>{
 const {quotaReached}=await import("../../src/modules/distribution/network.policy.js");
 assert.equal(quotaReached(0,0),true);
 assert.equal(quotaReached(1,0),false);
 assert.equal(quotaReached(1,1),true);
 assert.equal(quotaReached(null,500),false);
});
test("o preço da confirmação precisa coincidir com a tabela",async()=>{
 const {expectedPriceMatches}=await import("../../src/modules/distribution/network.policy.js");
 assert.equal(expectedPriceMatches(10,10),true);
 assert.equal(expectedPriceMatches(11,10),false);
 assert.equal(expectedPriceMatches(10.5,10.5),false);
});
