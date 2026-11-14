import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canUseInvite, quotaReached } from "../../src/modules/distribution/network.policy.js";
const file=path=>readFileSync(new URL(path,import.meta.url),"utf8");

test("sem limites implícitos, mas limites explícitos permanecem",()=>{
 assert.equal(canUseInvite({uses:3000,max_uses:null,expires_at:null,revoked_at:null}),true);
 assert.equal(canUseInvite({uses:3,max_uses:3,expires_at:null,revoked_at:null}),false);
 assert.equal(quotaReached(null,99999),false);
 assert.equal(quotaReached(0,0),true);
 assert.equal(quotaReached(5,5),true);
});
test("SQL de consumo reconhece convite sem limite e revalida a expiração",()=>{
 const source=file("../../src/modules/distribution/network.service.js");
 assert.match(source,/max_uses IS NULL OR uses<max_uses/);
 assert.match(source,/expires_at IS NULL OR expires_at>now\(\)/);
 assert.doesNotMatch(source,/NETWORK_MAX_DEPTH/);
});
test("migração aditiva admite null nos quatro campos de quota",()=>{
 const source=file("../../src/db/migrations/20261212000002-network-unlimited-defaults.cjs");
 for(const field of ["max_children", "max_depth", "expires_at", "max_uses"])
   assert.match(source,new RegExp(`ALTER COLUMN ${field} DROP NOT NULL`));
});
