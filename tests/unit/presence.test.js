import test from "node:test";
import assert from "node:assert/strict";
import { sequelize } from "../../src/db/sequelize.js";
import {
  touchDevice, isOnline, presenceOf, onlineSql, flushPresence, _resetPresence, _dirtySize,
} from "../../src/modules/devices/presence.js";

const W = 90_000;
const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

test("isOnline respeita a janela", () => {
  const now = Date.now();
  assert.equal(isOnline(new Date(now - 10_000), { now, window: W }), true);
  assert.equal(isOnline(new Date(now - W), { now, window: W }), true); // limite inclusivo
  assert.equal(isOnline(new Date(now - W - 1), { now, window: W }), false);
  assert.equal(isOnline(null, { now, window: W }), false);
  assert.equal(isOnline("lixo", { now, window: W }), false);
});

test("presenceOf usa o mais recente entre memória e banco", () => {
  _resetPresence();
  const old = new Date(Date.now() - 10 * 60_000);
  assert.deepEqual(presenceOf(ID, old).online, false);
  touchDevice(ID);
  const p = presenceOf(ID, old);
  assert.equal(p.online, true);
  assert.ok(p.lastSeenAt.getTime() > old.getTime());
  // sem memória: vale o banco
  const recent = new Date(Date.now() - 5_000);
  assert.equal(presenceOf(ID2, recent).online, true);
  assert.deepEqual(presenceOf(ID2, null), { online: false, lastSeenAt: null });
});

test("touchDevice ignora id vazio", () => {
  _resetPresence();
  touchDevice(undefined);
  touchDevice(null);
  assert.equal(_dirtySize(), 0);
});

test("onlineSql gera condições com inteiros apenas", () => {
  assert.match(onlineSql("Device", true), /"Device"\."last_seen_at" >= now\(\) - \(\d+ \* interval '1 second'\)/);
  assert.match(onlineSql("Device", false), /IS NULL OR/);
});

test("flush grava em lote UMA query e limpa a fila; falha devolve à fila", async () => {
  _resetPresence();
  const calls = [];
  const orig = sequelize.query;
  sequelize.query = async (sql, opts) => { calls.push({ sql, opts }); };
  try {
    touchDevice(ID); touchDevice(ID2); touchDevice(ID); // duplicado conta uma vez
    assert.equal(await flushPresence(), 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts.replacements.ids.sort(), [ID, ID2].sort());
    assert.match(calls[0].sql, /d\.last_seen_at < v\.ts/); // nunca regride o relógio
    assert.equal(_dirtySize(), 0);
    assert.equal(await flushPresence(), 0); // nada pendente = nenhuma query
    assert.equal(calls.length, 1);

    sequelize.query = async () => { throw new Error("db fora"); };
    const err = console.error; console.error = () => {};
    touchDevice(ID);
    assert.equal(await flushPresence(), 0);
    console.error = err;
    assert.equal(_dirtySize(), 1); // voltou para a fila
  } finally {
    sequelize.query = orig;
    _resetPresence();
  }
});
