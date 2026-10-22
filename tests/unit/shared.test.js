import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMac } from "../../src/shared/mac.js";
import { addMonthsUTC, dueDateFor, competenceBounds, daysBetween } from "../../src/shared/dates.js";
import { generateCode, hashCode, hashPassword, verifyPassword, signJwt, verifyJwt, encryptSecret, decryptSecret } from "../../src/shared/crypto.js";
import { isPrivateAddress, assertPublicUrl } from "../../src/shared/ssrf.js";
import { maskDeep } from "../../src/shared/mask.js";

test("normalizeMac aceita formatos comuns e rejeita inválidos", () => {
  assert.equal(normalizeMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("aabb.ccdd.eeff"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("AABBCCDDEEFF"), "AA:BB:CC:DD:EE:FF");
  assert.equal(normalizeMac("00:00:00:00:00:00"), null);
  assert.equal(normalizeMac("zz:bb:cc:dd:ee:ff"), null);
  assert.equal(normalizeMac(123), null);
});
test("datas: fim de mês é preservado em UTC", () => {
  assert.equal(addMonthsUTC(new Date("2026-08-31T00:00:00Z"), 6).toISOString(), "2027-02-28T00:00:00.000Z");
  assert.equal(addMonthsUTC(new Date("2026-10-15T10:00:00Z"), 12).toISOString(), "2027-10-15T10:00:00.000Z");
  assert.equal(dueDateFor("2027-02", 28), "2027-02-28");
  assert.equal(competenceBounds("2026-12").end.toISOString(), "2027-01-01T00:00:00.000Z");
  assert.equal(daysBetween("2026-10-01", "2026-10-15"), 14);
});
test("códigos: formato, unicidade e hash determinístico", () => {
  const a = generateCode("LIC");
  assert.match(a, /^LIC-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  assert.notEqual(a, generateCode("LIC"));
  assert.equal(hashCode(a), hashCode(a.toLowerCase().replaceAll("-", " ")));
  assert.notEqual(hashCode(a), hashCode(generateCode("LIC")));
});
test("senha: hash verifica e rejeita senha errada", async () => {
  const h = await hashPassword("correta-horse-battery");
  assert.ok(await verifyPassword("correta-horse-battery", h));
  assert.ok(!(await verifyPassword("errada", h)));
});
test("JWT: valida assinatura, tipo e expiração", () => {
  const t = signJwt({ typ: "device", sid: "x" }, 60);
  assert.equal(verifyJwt(t, "device").sid, "x");
  assert.throws(() => verifyJwt(t, "admin"));
  assert.throws(() => verifyJwt(t.slice(0, -2) + "xx", "device"));
  assert.throws(() => verifyJwt(signJwt({ typ: "device" }, -10), "device"));
  assert.throws(() => verifyJwt("a.b.c"));
});
test("AES-GCM: round-trip e detecção de adulteração", () => {
  const blob = encryptSecret("http://u:p@host/x.m3u");
  assert.equal(decryptSecret(blob), "http://u:p@host/x.m3u");
  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptSecret(parts.join(".")));
});
test("SSRF: bloqueia faixas privadas e esquemas inválidos", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress("8.8.8.8"));
  await assert.rejects(assertPublicUrl("http://127.0.0.1/x"), /não permitido/i);
  await assert.rejects(assertPublicUrl("http://localhost:3000/"), /não permitido/i);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /HTTP/);
  await assert.rejects(assertPublicUrl("http://[::1]/"), /não permitido/i);
});
test("auditoria mascara dados sensíveis", () => {
  const m = maskDeep({ password: "x", nested: { refreshToken: "y", licenseCode: "z", ok: 1 }, url: "http://u:p@h" });
  assert.equal(m.password, "[REDACTED]");
  assert.equal(m.nested.refreshToken, "[REDACTED]");
  assert.equal(m.nested.licenseCode, "[REDACTED]");
  assert.equal(m.url, "[REDACTED]");
  assert.equal(m.nested.ok, 1);
});
