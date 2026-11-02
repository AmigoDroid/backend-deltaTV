import assert from "node:assert/strict";
import test from "node:test";
import { matchesPartnerDeletionConfirmation } from "../../src/modules/partner-deletion-confirmation.js";

const partner = { name: "Revenda São João", slug: "revenda-sao-joao" };
test("aceita nome comercial exato", () => {
  assert.equal(matchesPartnerDeletionConfirmation("Revenda São João", partner), true);
});
test("aceita slug da versão antiga", () => {
  assert.equal(matchesPartnerDeletionConfirmation("revenda-sao-joao", partner), true);
});
test("tolera espaços e caixa na confirmação", () => {
  assert.equal(matchesPartnerDeletionConfirmation("  REVENDA SÃO JOÃO  ", partner), true);
});
test("rejeita nome de outra parceria e confirmação vazia", () => {
  assert.equal(matchesPartnerDeletionConfirmation("Revenda Outro", partner), false);
  assert.equal(matchesPartnerDeletionConfirmation("", partner), false);
});
test("rejeita fragmentos do nome para evitar exclusão acidental", () => {
  assert.equal(matchesPartnerDeletionConfirmation("Revenda", partner), false);
});
