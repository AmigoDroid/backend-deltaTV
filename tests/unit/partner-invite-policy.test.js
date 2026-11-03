import test from "node:test";
import assert from "node:assert/strict";
import { INVITE_LIFETIME_MS, normalizeInviteEmail, hashInviteToken, generateInviteToken, escapeMailHtml, inviteUrl, inviteIsValid } from "../../src/modules/partners/partner-invite.policy.js";

test("convite possui 32 bytes de entropia e é não determinístico", () => {
  const a = generateInviteToken(), b = generateInviteToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});
test("somente hash SHA-256 do convite é persistido", () => {
  const token = generateInviteToken();
  assert.match(hashInviteToken(token), /^[a-f0-9]{64}$/);
  assert.equal(hashInviteToken(token), hashInviteToken(token));
  assert.ok(!hashInviteToken(token).includes(token));
});
test("link do convite usa rota pública /convite/TOKEN, sem query ou hash", () => {
  const token = generateInviteToken();
  const url = new URL(inviteUrl("https://parceiro.deltatv.com.br", token));
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(url.pathname, `/convite/${token}`);
});
test("convites só são válidos se convidados e dentro do prazo", () => {
  const now = Date.now();
  assert.equal(INVITE_LIFETIME_MS, 72 * 3600 * 1000);
  assert.ok(inviteIsValid({ status: "invited", expiresAt: new Date(now + 5000) }, now));
  assert.ok(!inviteIsValid({ status: "draft", expiresAt: new Date(now + 5000) }, now));
  assert.ok(!inviteIsValid({ status: "completed", expiresAt: new Date(now + 5000) }, now));
  assert.ok(!inviteIsValid({ status: "invited", expiresAt: new Date(now - 1) }, now));
});
test("normaliza e-mail e escapa HTML de origem não confiável", () => {
  assert.equal(normalizeInviteEmail(" TEST@Example.COM "), "test@example.com");
  assert.equal(escapeMailHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});
