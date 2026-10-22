import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.MIRROR_TOKEN_TTL_DAYS = "30";
const { cachedMirrorAuth, dropMirrorAuth, clearMirrorAuth, mirrorAuthCacheSize } = await import("../../src/modules/mirror/mirror.cache.js");
const { AppError } = await import("../../src/shared/errors.js");
const { signJwt, verifyJwt } = await import("../../src/shared/crypto.js");

beforeEach(() => clearMirrorAuth());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loader = (counter, value = { mode: "proxy" }, activationId = "a1") => async () => { counter.n++; return { activationId, value }; };

test("só a primeira requisição do token vai ao banco; as demais saem da memória", async () => {
  const c = { n: 0 };
  for (let i = 0; i < 50; i++) assert.deepEqual(await cachedMirrorAuth("t1", loader(c), 1000), { mode: "proxy" });
  assert.equal(c.n, 1);
});

test("requisições simultâneas compartilham UMA consulta (single-flight)", async () => {
  const c = { n: 0 };
  const slow = async () => { c.n++; await sleep(30); return { activationId: "a1", value: { mode: "redirect" } }; };
  const r = await Promise.all(Array.from({ length: 20 }, () => cachedMirrorAuth("t2", slow, 1000)));
  assert.equal(c.n, 1);
  assert.ok(r.every((x) => x.mode === "redirect"));
});

test("expira pelo TTL e recarrega (mudança de modo vale em até o TTL)", async () => {
  let mode = "proxy";
  const c = { n: 0 };
  const load = async () => { c.n++; return { activationId: "a1", value: { mode } }; };
  assert.equal((await cachedMirrorAuth("t3", load, 40)).mode, "proxy");
  mode = "redirect";
  assert.equal((await cachedMirrorAuth("t3", load, 40)).mode, "proxy"); // ainda em cache
  await sleep(60);
  assert.equal((await cachedMirrorAuth("t3", load, 40)).mode, "redirect");
  assert.equal(c.n, 2);
});

test("dropMirrorAuth(activationId) derruba o cache na hora (revogação no mesmo processo)", async () => {
  const c = { n: 0 };
  await cachedMirrorAuth("t4", loader(c, { x: 1 }, "act-9"), 60000);
  await cachedMirrorAuth("t5", loader(c, { x: 2 }, "act-other"), 60000);
  dropMirrorAuth("act-9");
  await cachedMirrorAuth("t4", loader(c, { x: 1 }, "act-9"), 60000);
  await cachedMirrorAuth("t5", loader(c, { x: 2 }, "act-other"), 60000);
  assert.equal(c.n, 3); // t4 recarregou; t5 continuou em cache
});

test("negação (403) é guardada por pouco tempo; erro de banco não é guardado", async () => {
  const c = { n: 0 };
  const denied = async () => { c.n++; throw new AppError(403, "BLOCKED", "Bloqueado."); };
  for (let i = 0; i < 5; i++) await assert.rejects(cachedMirrorAuth("t6", denied, 60000), { code: "BLOCKED" });
  assert.equal(c.n, 1);

  const c2 = { n: 0 };
  const dbDown = async () => { c2.n++; throw new Error("ECONNREFUSED"); };
  for (let i = 0; i < 3; i++) await assert.rejects(cachedMirrorAuth("t7", dbDown, 60000));
  assert.equal(c2.n, 3);
});

test("TTL 0 desliga o cache", async () => {
  const c = { n: 0 };
  for (let i = 0; i < 4; i++) await cachedMirrorAuth("t8", loader(c), 0);
  assert.equal(c.n, 4);
  assert.equal(mirrorAuthCacheSize(), 0);
});

test("limite de entradas: o cache não cresce sem fim", async () => {
  const c = { n: 0 };
  for (let i = 0; i < 5100; i++) await cachedMirrorAuth(`k${i}`, loader(c), 60000);
  assert.ok(mirrorAuthCacheSize() <= 5000);
});

test("signJwt com iat fixo gera sempre o mesmo token (o app não descarta o catálogo à toa)", () => {
  const a = signJwt({ typ: "mirror", sid: "s", aid: "a" }, 2592000, { iat: 1_700_000_000 });
  const b = signJwt({ typ: "mirror", sid: "s", aid: "a" }, 2592000, { iat: 1_700_000_000 });
  assert.equal(a, b);
  const p = JSON.parse(Buffer.from(a.split(".")[1], "base64url"));
  assert.equal(p.exp - p.iat, 2592000);
  assert.notEqual(a, signJwt({ typ: "mirror", sid: "s", aid: "a" }, 2592000, { iat: 1_700_000_001 }));
  // sem iat: comportamento antigo (relógio atual) — verifica e é aceito
  assert.equal(verifyJwt(signJwt({ typ: "device" }, 60), "device").typ, "device");
});
