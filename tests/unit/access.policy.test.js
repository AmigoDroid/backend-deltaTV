import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccess, effectiveLicenseStatus } from "../../src/modules/access/access.policy.js";

const NOW = new Date("2026-10-15T12:00:00Z");
const active = { status: "active" };
const lic = (over = {}) => ({ status: "active", startsAt: new Date("2026-06-01Z"), expiresAt: new Date("2027-06-01Z"), ...over });
const par = (over = {}) => ({
  status: "active", startsAt: new Date("2026-01-01Z"), endsAt: new Date("2027-01-01Z"),
  suspendPolicy: "auto_after_grace", graceDays: 5, ...over,
});

test("licença válida é autorizada", () => {
  const r = evaluateAccess({ activation: active, license: lic(), now: NOW });
  assert.equal(r.allowed, true);
});
test("licença expirada é negada", () => {
  const r = evaluateAccess({ activation: active, license: lic({ expiresAt: new Date("2026-10-15T11:59:59Z") }), now: NOW });
  assert.equal(r.code, "LICENSE_EXPIRED");
});
test("licença bloqueada/suspensa/cancelada é negada", () => {
  for (const [s, c] of [["blocked", "LICENSE_BLOCKED"], ["suspended", "LICENSE_SUSPENDED"], ["cancelled", "LICENSE_CANCELLED"]]) {
    assert.equal(evaluateAccess({ activation: active, license: lic({ status: s }), now: NOW }).code, c);
  }
});
test("bloqueio de dispositivo nega só aquela ativação; revogada também", () => {
  assert.equal(evaluateAccess({ activation: { status: "blocked" }, license: lic(), now: NOW }).code, "DEVICE_BLOCKED");
  assert.equal(evaluateAccess({ activation: { status: "revoked" }, license: lic(), now: NOW }).code, "ACTIVATION_REVOKED");
  assert.equal(evaluateAccess({ activation: active, license: lic(), now: NOW }).allowed, true);
});
test("parceria ativa autoriza; bloqueada/suspensa/expirada nega", () => {
  assert.equal(evaluateAccess({ activation: active, partner: par(), now: NOW }).allowed, true);
  assert.equal(evaluateAccess({ activation: active, partner: par({ status: "blocked" }), now: NOW }).code, "PARTNER_BLOCKED");
  assert.equal(evaluateAccess({ activation: active, partner: par({ status: "suspended" }), now: NOW }).code, "PARTNER_SUSPENDED");
  assert.equal(evaluateAccess({ activation: active, partner: par({ endsAt: new Date("2026-10-01Z") }), now: NOW }).code, "PARTNER_EXPIRED");
});
test("inadimplência: respeita tolerância e política", () => {
  // vencida há 5 dias com tolerância 5 -> ainda permitido; 6 dias -> negado
  assert.equal(evaluateAccess({ activation: active, partner: par(), overdueSince: "2026-10-10", now: NOW }).allowed, true);
  assert.equal(evaluateAccess({ activation: active, partner: par(), overdueSince: "2026-10-09", now: NOW }).code, "PARTNER_DELINQUENT");
  // política manual não bloqueia automaticamente
  assert.equal(evaluateAccess({ activation: active, partner: par({ suspendPolicy: "manual" }), overdueSince: "2026-01-01", now: NOW }).allowed, true);
});
test("reativação: mesmo estado volta a autorizar (acesso é derivado)", () => {
  const before = evaluateAccess({ activation: active, partner: par({ status: "suspended" }), now: NOW });
  const after = evaluateAccess({ activation: active, partner: par({ status: "active" }), now: NOW });
  assert.equal(before.allowed, false);
  assert.equal(after.allowed, true);
});
test("mensagem de parceria não expõe detalhes administrativos", () => {
  const r = evaluateAccess({ activation: active, partner: par({ status: "suspended", statusReason: "inadimplência" }), now: NOW });
  assert.ok(!r.message.toLowerCase().includes("inadimpl"));
});
test("status efetivo marca expirada", () => {
  assert.equal(effectiveLicenseStatus(lic({ expiresAt: new Date("2026-01-01Z") }), NOW), "expired");
});
