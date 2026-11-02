import test from "node:test";
import assert from "node:assert/strict";
import { canReceiveChange, sameSessionClaims } from "../../src/realtime/routing-policy.js";
test("mutação administrativa global não notifica revendas", () => {
  assert.equal(canReceiveChange({role:"partner",partnerId:"A"}, null), false);
  assert.equal(canReceiveChange({role:"partner",partnerId:"A"}, "B"), false);
  assert.equal(canReceiveChange({role:"partner",partnerId:"A"}, "A"), true);
  assert.equal(canReceiveChange({role:"superadmin"}, null), true);
});
test("troca de função, vínculo, status ou versão revoga o WebSocket", () => {
  const peer={user:{role:"superadmin",partnerId:null},tokenVersion:3};
  const user={status:"active",role:"superadmin",partnerId:null,tokenVersion:3};
  assert.equal(sameSessionClaims(user,peer),true);
  assert.equal(sameSessionClaims({...user,status:"disabled"},peer),false);
  assert.equal(sameSessionClaims({...user,role:"admin"},peer),false);
  assert.equal(sameSessionClaims({...user,partnerId:"other"},peer),false);
  assert.equal(sameSessionClaims({...user,tokenVersion:4},peer),false);
});
