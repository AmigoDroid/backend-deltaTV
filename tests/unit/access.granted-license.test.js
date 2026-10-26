import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccess } from "../../src/modules/access/access.policy.js";

const now = new Date("2026-10-27T12:00:00Z");
const day = 86_400_000;
const license = (over = {}) => ({ status: "active", startsAt: new Date(now - 10 * day), expiresAt: new Date(now.getTime() + 20 * day), ...over });
const partner = (over = {}) => ({ status: "active", startsAt: new Date(now - 100 * day), endsAt: new Date(now.getTime() + 100 * day), suspendPolicy: "auto_after_grace", graceDays: 5, ...over });
const active = { status: "active" };

test("licença concedida em vigor libera e o vencimento é o da licença", () => {
  const l = license();
  const d = evaluateAccess({ activation: active, grantedLicense: l, partner: partner(), now });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.expiresAt, new Date(l.expiresAt));
});

test("licença concedida vencida nega com LICENSE_EXPIRED, mesmo com o revendedor em dia", () => {
  const d = evaluateAccess({ activation: active, grantedLicense: license({ expiresAt: new Date(now - day) }), partner: partner(), now });
  assert.equal(d.allowed, false);
  assert.equal(d.code, "LICENSE_EXPIRED");
});

test("vigência encerrada ou inadimplência do portal NÃO derrubam cliente com licença em vigor", () => {
  const expiredPartner = partner({ endsAt: new Date(now - day) });
  assert.equal(evaluateAccess({ activation: active, grantedLicense: license(), partner: expiredPartner, now }).allowed, true);
  const overdue = evaluateAccess({ activation: active, grantedLicense: license(), partner: partner(), now, overdueSince: "2026-01-01" });
  assert.equal(overdue.allowed, true);
});

test("suspensão do portal não derruba, mas bloqueio e cancelamento do revendedor sim", () => {
  assert.equal(evaluateAccess({ activation: active, grantedLicense: license(), partner: partner({ status: "suspended" }), now }).allowed, true);
  assert.equal(evaluateAccess({ activation: active, grantedLicense: license(), partner: partner({ status: "blocked" }), now }).code, "PARTNER_BLOCKED");
  assert.equal(evaluateAccess({ activation: active, grantedLicense: license(), partner: partner({ status: "cancelled" }), now }).code, "PARTNER_CANCELLED");
});

test("licença bloqueada/suspensa/cancelada nega; ativação bloqueada ou revogada nega antes da licença", () => {
  for (const [status, code] of [["blocked", "LICENSE_BLOCKED"], ["suspended", "LICENSE_SUSPENDED"], ["cancelled", "LICENSE_CANCELLED"]]) {
    assert.equal(evaluateAccess({ activation: active, grantedLicense: license({ status }), partner: partner(), now }).code, code);
  }
  assert.equal(evaluateAccess({ activation: { status: "blocked" }, grantedLicense: license(), partner: partner(), now }).code, "DEVICE_BLOCKED");
  assert.equal(evaluateAccess({ activation: { status: "revoked" }, grantedLicense: license(), partner: partner(), now }).code, "ACTIVATION_REVOKED");
});

test("sem licença concedida a parceria de conteúdo segue como antes (vigência do parceiro)", () => {
  const p = partner();
  const d = evaluateAccess({ activation: active, partner: p, now });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.expiresAt, new Date(p.endsAt));
  assert.equal(evaluateAccess({ activation: active, partner: partner({ endsAt: new Date(now - day) }), now }).code, "PARTNER_EXPIRED");
});

test("licença individual (license) continua com precedência e inalterada", () => {
  const d = evaluateAccess({ activation: active, license: license(), partner: partner({ status: "blocked" }), now });
  assert.equal(d.allowed, true); // comportamento original: com licença individual, o parceiro não é consultado
  assert.equal(evaluateAccess({ activation: active, license: license({ status: "pending" }), now }).code, "LICENSE_NOT_STARTED");
});

test("transferir preserva o prazo: o vencimento depende só da licença, não do MAC", () => {
  const l = license();
  const a = evaluateAccess({ activation: { status: "active", mac: "AA:AA:AA:AA:AA:01" }, grantedLicense: l, partner: partner(), now });
  const b = evaluateAccess({ activation: { status: "active", mac: "BB:BB:BB:BB:BB:02" }, grantedLicense: l, partner: partner(), now });
  assert.deepEqual(a.expiresAt, b.expiresAt);
});
