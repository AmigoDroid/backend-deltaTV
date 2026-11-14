import test from "node:test";
import assert from "node:assert/strict";
import { invitedSignupState, INVITED_RESELLER_RESTRICTED_RESOURCES, buildResellerInviteUrl } from "../../src/modules/distribution/invite-onboarding.policy.js";

test("cadastro público sem convite segue pendente",()=>{
  assert.deepEqual(invitedSignupState(false),{status:"suspended",statusReason:"Aguardando aprovação do cadastro"});
});
test("convite consumido habilita revenda dentro da rede",()=>{
  assert.deepEqual(invitedSignupState(true),{status:"active",statusReason:null});
});
test("cadastro automático não concede recursos sensíveis",()=>{
  assert.ok(INVITED_RESELLER_RESTRICTED_RESOURCES.includes("servers"));
  assert.ok(INVITED_RESELLER_RESTRICTED_RESOURCES.includes("white_label"));
  assert.ok(INVITED_RESELLER_RESTRICTED_RESOURCES.includes("remote"));
  assert.equal(new Set(INVITED_RESELLER_RESTRICTED_RESOURCES).size,INVITED_RESELLER_RESTRICTED_RESOURCES.length);
});

test("link de convite leva para a tela pública correta e conserva token apenas no fragmento",()=>{
  const token="abcDEF0123456789_".repeat(3);
  const link=buildResellerInviteUrl("https://revenda.deltatv.com.br",token);
  const url=new URL(link);
  assert.equal(url.pathname,"/");
  assert.equal(url.search,"");
  assert.equal(url.hash,`#cadastro?convite=${token}`);
});
test("origens estranhas ou tokens curtos nunca geram convite",()=>{
  assert.throws(()=>buildResellerInviteUrl("javascript:alert(1)","a".repeat(48)));
  assert.throws(()=>buildResellerInviteUrl("https://revenda.deltatv.com.br/outro","a".repeat(48)));
  assert.throws(()=>buildResellerInviteUrl("https://revenda.deltatv.com.br","ruim"));
});
