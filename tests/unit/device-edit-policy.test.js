import test from "node:test";
import assert from "node:assert/strict";
import { evaluateResellerAccess, normalizePolicy } from "../../src/modules/devices/device-edit-policy.js";

const R1 = { id: "r1", kind: "reseller" };
const free = { ownerPartnerIds: [], hasLiveActivation: false };
const ownedByR2 = { ownerPartnerIds: ["r2"], hasLiveActivation: true };
const ownedByR1 = { ownerPartnerIds: ["r1"], hasLiveActivation: true };
const ev = (over) => evaluateResellerAccess({ partner: R1, partnerEffectiveStatus: "active", policy: "any_reseller", device: free, ...over });

test("any_reseller (padrão): qualquer revendedor ativo edita qualquer MAC, inclusive de outro revendedor", () => {
  assert.equal(ev({}).allowed, true);
  assert.equal(ev({ device: ownedByR2 }).allowed, true);
  assert.equal(ev({ policy: undefined, device: ownedByR2 }).allowed, true, "política desconhecida cai no padrão");
});

test("quem não é revendedor não edita por MAC (parceria de conteúdo pura, sem conta de partner)", () => {
  assert.equal(ev({ partner: { id: "p", kind: "content" } }).code, "NOT_A_RESELLER");
  assert.equal(ev({ partner: null }).code, "NOT_A_RESELLER");
  assert.equal(ev({ partner: { id: "p", kind: "both" } }).allowed, true);
});

test("revendedor suspenso, bloqueado, expirado ou cancelado não edita", () => {
  for (const s of ["suspended", "blocked", "expired", "cancelled", "pending"]) {
    const r = ev({ partnerEffectiveStatus: s });
    assert.equal(r.allowed, false, s);
    assert.equal(r.code, "RESELLER_INACTIVE");
  }
});

test("owner_only: bloqueia MAC de outro revendedor, libera o próprio e o que está livre", () => {
  assert.equal(ev({ policy: "owner_only", device: ownedByR2 }).code, "DEVICE_OWNED_BY_OTHER");
  assert.equal(ev({ policy: "owner_only", device: ownedByR1 }).allowed, true);
  assert.equal(ev({ policy: "owner_only", device: free }).allowed, true);
});

test("normalizePolicy", () => {
  assert.equal(normalizePolicy("owner_only"), "owner_only");
  assert.equal(normalizePolicy("qualquer"), "any_reseller");
  assert.equal(normalizePolicy(undefined), "any_reseller");
});
