import test from "node:test";
import assert from "node:assert/strict";
import { cleanText, parsePhone, parseDueDate, daysUntil, todaySP } from "../../src/modules/clients/client.rules.js";

test("texto: apara, colapsa espaços e vazio vira null; undefined = não enviado", () => {
  assert.equal(cleanText("  João   da  Silva "), "João da Silva");
  assert.equal(cleanText("   "), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText(undefined), undefined);
});

test("telefone: aceita máscara, exige 8 a 15 dígitos, recusa letras", () => {
  assert.deepEqual(parsePhone("(85) 99999-0000"), { value: "(85) 99999-0000" });
  assert.deepEqual(parsePhone("+55 85 99999 0000"), { value: "+55 85 99999 0000" });
  assert.deepEqual(parsePhone(""), { value: null });
  assert.deepEqual(parsePhone(undefined), { value: undefined });
  assert.ok(parsePhone("123").error);
  assert.ok(parsePhone("85 9999-0000 ramal abc").error);
  assert.ok(parsePhone("1".repeat(16)).error);
});

test("vencimento: só datas reais", () => {
  assert.deepEqual(parseDueDate("2026-11-30"), { value: "2026-11-30" });
  assert.deepEqual(parseDueDate(""), { value: null });
  assert.deepEqual(parseDueDate(null), { value: null });
  assert.deepEqual(parseDueDate(undefined), { value: undefined });
  assert.ok(parseDueDate("2026-02-31").error);
  assert.ok(parseDueDate("30/11/2026").error);
  assert.ok(parseDueDate("1999-01-01").error);
  assert.deepEqual(parseDueDate("2028-02-29"), { value: "2028-02-29" }); // bissexto
});

test("dias até o vencimento usa a data de São Paulo (UTC-3)", () => {
  // 2026-10-27 01:00 UTC = 2026-10-26 22:00 em São Paulo
  const now = new Date("2026-10-27T01:00:00Z");
  assert.equal(todaySP(now), "2026-10-26");
  assert.equal(daysUntil("2026-10-26", now), 0);
  assert.equal(daysUntil("2026-10-25", now), -1);
  assert.equal(daysUntil("2026-11-02", now), 7);
  assert.equal(daysUntil(null, now), null);
});
