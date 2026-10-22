import test from "node:test";
import assert from "node:assert/strict";
import { calculateAmount } from "../../src/modules/billing/billing.calc.js";

test("mensalidade fixa independe da quantidade", () => {
  assert.equal(calculateAmount({ billingModel: "fixed", monthlyFeeCents: 19900 }, 500).amountCents, 19900);
});
test("por dispositivo respeita mínimo", () => {
  const p = { billingModel: "per_device", perDeviceCents: 300, minFeeCents: 5000 };
  assert.equal(calculateAmount(p, 10).amountCents, 5000);
  assert.equal(calculateAmount(p, 100).amountCents, 30000);
});
test("por faixa escolhe a faixa correta, inclusive a final", () => {
  const p = { billingModel: "tiered", tiers: [{ upTo: null, amountCents: 90000 }, { upTo: 50, amountCents: 20000 }, { upTo: 200, amountCents: 50000 }] };
  assert.equal(calculateAmount(p, 0).amountCents, 20000);
  assert.equal(calculateAmount(p, 50).amountCents, 20000);
  assert.equal(calculateAmount(p, 51).amountCents, 50000);
  assert.equal(calculateAmount(p, 999).amountCents, 90000);
});
test("faixas que não cobrem a quantidade geram erro", () => {
  assert.throws(() => calculateAmount({ billingModel: "tiered", tiers: [{ upTo: 10, amountCents: 1 }] }, 11), /faixa/i);
});
