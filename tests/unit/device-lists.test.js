import test from "node:test";
import assert from "node:assert/strict";
import { pickPrimaryList, selectActivation } from "../../src/modules/devices/device-lists.js";

const list = (id, extra = {}) => ({ id, activationId: id, allowed: false, configured: false, ...extra });

test("pickPrimaryList: sem listas devolve null", () => {
  assert.equal(pickPrimaryList([]), null);
  assert.equal(pickPrimaryList(undefined), null);
});

test("pickPrimaryList: prefere liberada+configurada, depois liberada, depois configurada, depois a primeira", () => {
  const a = list("a", { configured: true });                  // configurada, mas bloqueada
  const b = list("b", { allowed: true });                     // liberada, sem configuração
  const c = list("c", { allowed: true, configured: true });   // ideal
  assert.equal(pickPrimaryList([a, b, c]).id, "c");
  assert.equal(pickPrimaryList([a, b]).id, "b");
  assert.equal(pickPrimaryList([a, list("d")]).id, "a");
  assert.equal(pickPrimaryList([list("x"), list("y")]).id, "x");
});

test("pickPrimaryList: empate fica com a primeira (a mais recente, pela ordem do serviço)", () => {
  const recent = list("recent", { allowed: true, configured: true });
  const old = list("old", { allowed: true, configured: true });
  assert.equal(pickPrimaryList([recent, old]).id, "recent");
});

test("selectActivation: nenhuma ativação viva", () => {
  assert.deepEqual(selectActivation([], undefined), { activation: null });
});

test("selectActivation: uma só, sem activationId, é a escolhida", () => {
  const only = { id: "a1" };
  assert.equal(selectActivation([only], undefined).activation, only);
});

test("selectActivation: várias sem activationId é ambíguo (nunca adivinha)", () => {
  const r = selectActivation([{ id: "a1" }, { id: "a2" }], undefined);
  assert.equal(r.activation, null);
  assert.equal(r.error, "ACTIVATION_REQUIRED");
});

test("selectActivation: activationId precisa ser uma das vivas do dispositivo", () => {
  const live = [{ id: "a1" }, { id: "a2" }];
  assert.equal(selectActivation(live, "a2").activation, live[1]);
  const miss = selectActivation(live, "outra-de-outro-dispositivo");
  assert.equal(miss.activation, null);
  assert.equal(miss.error, "NOT_FOUND");
});

test("selectActivation: activationId inexistente falha mesmo havendo uma só ativação", () => {
  assert.equal(selectActivation([{ id: "a1" }], "zzz").error, "NOT_FOUND");
});
