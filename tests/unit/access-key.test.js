import test from "node:test";
import assert from "node:assert/strict";
import { generateKey, hashKey, newKeyRecord, evaluateKeyAttempt, isWellFormed } from "../../src/modules/devices/access-key.js";

const PEPPER = "pepper-de-teste-com-mais-de-16-chars";
const DEV = "11111111-1111-4111-8111-111111111111";
const t0 = new Date("2026-10-17T12:00:00Z");
const wrong = (k) => (k === "000000" ? "000001" : "000000");

test("chave tem sempre 6 dígitos, inclusive com zeros à esquerda", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) { const k = generateKey(); assert.match(k, /^\d{6}$/); seen.add(k[0]); }
  assert.equal(seen.size, 10, "todos os dígitos iniciais (incl. 0) devem aparecer");
});

test("chaves não se repetem de forma suspeita (amostra de 2000)", () => {
  const s = new Set(Array.from({ length: 2000 }, generateKey));
  assert.ok(s.size > 1950);
});

test("hash é amarrado ao dispositivo e ao pepper; exige pepper forte", () => {
  const a = hashKey(DEV, "123456", PEPPER);
  assert.notEqual(a, hashKey("22222222-2222-4222-8222-222222222222", "123456", PEPPER));
  assert.notEqual(a, hashKey(DEV, "123456", PEPPER + "x"));
  assert.throws(() => hashKey(DEV, "123456", "curto"));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("registro não guarda a chave em claro", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  assert.ok(!JSON.stringify(record).includes(key));
  assert.equal(record.expiresAt.getTime(), t0.getTime() + 600_000);
});

test("chave correta dentro da validade: ok e marca uso", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  const r = evaluateKeyAttempt(record, DEV, key, PEPPER, { now: new Date(t0.getTime() + 1000) });
  assert.equal(r.ok, true);
  assert.ok(r.next.usedAt);
});

test("chave é de uso único", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  const used = { ...record, usedAt: t0 };
  assert.equal(evaluateKeyAttempt(used, DEV, key, PEPPER, { now: t0 }).reason, "used");
});

test("chave expirada falha mesmo estando correta", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  const r = evaluateKeyAttempt(record, DEV, key, PEPPER, { now: new Date(t0.getTime() + 601_000) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("chave de outro dispositivo não vale", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  const r = evaluateKeyAttempt(record, "22222222-2222-4222-8222-222222222222", key, PEPPER, { now: t0 });
  assert.equal(r.ok, false);
});

test("5 erros invalidam a chave; depois disso nem a chave certa funciona", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  let rec = { ...record };
  for (let i = 1; i <= 5; i++) {
    const r = evaluateKeyAttempt(rec, DEV, wrong(key), PEPPER, { now: t0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, i < 5 ? "mismatch" : "attempts_exceeded");
    rec = { ...rec, ...r.next };
  }
  assert.ok(rec.invalidatedAt);
  const late = evaluateKeyAttempt(rec, DEV, key, PEPPER, { now: t0 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "invalidated");
});

test("acertar na 5ª tentativa ainda é aceito (limite é de ERROS)", () => {
  const { key, record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  let rec = { ...record };
  for (let i = 0; i < 4; i++) rec = { ...rec, ...evaluateKeyAttempt(rec, DEV, wrong(key), PEPPER, { now: t0 }).next };
  assert.equal(evaluateKeyAttempt(rec, DEV, key, PEPPER, { now: t0 }).ok, true);
});

test("entrada malformada conta como tentativa e nunca casa", () => {
  const { record } = newKeyRecord(DEV, PEPPER, { now: t0 });
  for (const bad of ["12345", "1234567", "12345a", "", null, undefined, 123456, " 12345"]) {
    const r = evaluateKeyAttempt(record, DEV, bad, PEPPER, { now: t0 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "malformed");
    assert.equal(r.next.attempts, 1);
  }
  assert.equal(isWellFormed("000000"), true);
});

test("sem registro: falha sem efeito colateral", () => {
  assert.deepEqual(evaluateKeyAttempt(null, DEV, "123456", PEPPER), { ok: false, reason: "no_key", next: null });
});
