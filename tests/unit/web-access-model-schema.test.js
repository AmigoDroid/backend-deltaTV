import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Verifica a regressão introduzida por mapeamento de coluna para a tabela errada.
const src = readFileSync(new URL("../../src/db/models/index.js", import.meta.url), "utf8");
function block(start, end) {
  const begin = src.indexOf(start);
  const finish = src.indexOf(end, begin + start.length);
  assert.ok(begin >= 0 && finish > begin, `Bloco não encontrado: ${start}`);
  return src.slice(begin, finish);
}
test("allowWebIssuance pertence a ContentPartnerTerms, não a Activation", () => {
  assert.match(block("export const ContentPartnerTerms", "export const ContentCodeBalance"), /allowWebIssuance\s*:/);
  assert.doesNotMatch(block("export const Activation", "export const WebAccess"), /allowWebIssuance\s*:/);
  assert.match(block("export const PartnerCode", "export const PartnerServicePlan"), /allowWebIssuance\s*:/);
});
