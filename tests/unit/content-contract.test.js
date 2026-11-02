import test from "node:test";
import assert from "node:assert/strict";
import {shouldCharge,remainingLicenses,rankHealthy} from "../../src/modules/content-commerce/contract.rules.js";
test("não cobrar novamente pelo mesmo código no login repetido",()=>{
 assert.equal(shouldCharge({isNew:false,previousCodeId:"a",codeId:"a"}),false);
 assert.equal(shouldCharge({isNew:true,previousCodeId:null,codeId:"a"}),true);
 assert.equal(shouldCharge({isNew:false,previousCodeId:"a",codeId:"b"}),true);
 assert.equal(shouldCharge({isNew:false,previousCodeId:"a",codeId:"b",alreadyCharged:true}),false);
});
test("planos de crédito e mensalidade calculam vagas",()=>{
 assert.equal(remainingLicenses({mode:"credits",availableCredits:8,creditsPerActivation:3}),2);
 assert.equal(remainingLicenses({mode:"fixed_limited",activationLimit:10,activeDevices:10}),0);
 assert.equal(remainingLicenses({mode:"fixed_limited",activationLimit:10,activeDevices:14}),0);
 assert.equal(remainingLicenses({mode:"fixed_unlimited"}),null);
});
test("saúde precede latência; modo automático prefere menor latência",()=>{
 const healthy={state:"healthy",latencyMs:250,priority:0};
 const faster={state:"healthy",latencyMs:70,priority:5};
 const dead={state:"down",latencyMs:1,priority:0};
 assert.ok(rankHealthy(faster,healthy,true)<0);
 assert.ok(rankHealthy(healthy,faster,false)<0);
 assert.ok(rankHealthy(healthy,dead,true)<0);
});
