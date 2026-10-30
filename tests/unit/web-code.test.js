import test from "node:test";
import assert from "node:assert/strict";
import { generateWebCode, normalizeWebCode, formatWebCode, generateWebMac, WEB_CODE_RE } from "../../src/modules/web/web-code.js";

test("código tem 2 letras + 6 dígitos e nunca usa I/O", () => {
  for (let i = 0; i < 2000; i++) {
    const c = generateWebCode();
    assert.match(c, WEB_CODE_RE);
    assert.doesNotMatch(c.slice(0, 2), /[IO]/);
  }
});

test("normalização aceita espaços, hífens e minúsculas", () => {
  assert.equal(normalizeWebCode("ab 123-456"), "AB123456");
  assert.equal(normalizeWebCode(" ab123456 "), "AB123456");
  assert.equal(normalizeWebCode("A1123456"), "");
  assert.equal(normalizeWebCode("ABC12345"), "");
  assert.equal(normalizeWebCode("AB12345"), "");
  assert.equal(normalizeWebCode("AB1234567"), "");
  assert.equal(normalizeWebCode(null), "");
  assert.equal(normalizeWebCode({}), "");
});

test("formatação agrupada", () => assert.equal(formatWebCode("AB123456"), "AB 123456"));

test("MAC virtual é válido, local e do prefixo web", () => {
  for (let i = 0; i < 200; i++) {
    const m = generateWebMac();
    assert.match(m, /^02:57:45(:[0-9A-F]{2}){3}$/);
  }
});
