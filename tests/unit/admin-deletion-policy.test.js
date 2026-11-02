import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccess } from "../../src/modules/access/access.policy.js";

const activeLicense = { status: "active", startsAt: new Date("2025-01-01"), expiresAt: new Date("2030-01-01") };
const activeActivation = { status: "active" };
const partner = (status) => ({ status, startsAt: new Date("2025-01-01"), endsAt: new Date("2030-01-01") });
test("parceiro excluído nunca autoriza a ativação, mesmo com licença concedida ativa", () => {
  const decision = evaluateAccess({ activation: activeActivation, grantedLicense: activeLicense, partner: partner("deleted") });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "PARTNER_DELETED");
});
test("aparelho independente com licença própria não é bloqueado por exclusão alheia", () => {
  assert.equal(evaluateAccess({ activation: activeActivation, license: activeLicense }).allowed, true);
});
test("ativação comum de parceiro ativo continua autorizada", () => {
  assert.equal(evaluateAccess({ activation: activeActivation, partner: partner("active") }).allowed, true);
});
