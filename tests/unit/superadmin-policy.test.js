import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustedExpiry,
  allowedRolePermissions,
  reportPeriod,
  csvCell,
} from "../../src/modules/superadmin/policy.js";
test("expiry adjustments preserve UTC instants and reject expiry before the start", () => {
  const license = {
    startsAt: "2026-11-01T03:00:00Z",
    expiresAt: "2026-12-01T03:00:00Z",
  };
  assert.equal(
    adjustedExpiry(license, { deltaDays: 1 }).toISOString(),
    "2026-12-02T03:00:00.000Z",
  );
  assert.throws(() => adjustedExpiry(license, { deltaDays: -40 }), {
    code: "INVALID_EXPIRY",
  });
  assert.throws(() => adjustedExpiry(license, { expiresAt: "invalid" }), {
    code: "INVALID_EXPIRY",
  });
});
test("custom roles can only narrow their base role and deduplicate permissions", () => {
  const catalog = { support: ["devices:read"] };
  assert.deepEqual(
    allowedRolePermissions(
      "support",
      ["devices:read", "devices:read"],
      catalog,
    ),
    ["devices:read"],
  );
  assert.throws(
    () => allowedRolePermissions("support", ["users:manage"], catalog),
    { code: "INVALID_PERMISSION" },
  );
});
test("report periods enforce ordering and a bounded query window", () => {
  assert.throws(() => reportPeriod({ from: "2026-11-02", to: "2026-11-01" }), {
    code: "INVALID_PERIOD",
  });
  assert.throws(() => reportPeriod({ from: "2020-01-01", to: "2026-01-01" }), {
    code: "INVALID_PERIOD",
  });
  assert.equal(
    reportPeriod({
      from: "2026-11-01T03:00:00Z",
      to: "2026-11-02T03:00:00Z",
    }).end.getTime() -
      reportPeriod({
        from: "2026-11-01T03:00:00Z",
        to: "2026-11-02T03:00:00Z",
      }).start.getTime(),
    86400000,
  );
});
test("CSV export neutralizes formulas and preserves embedded quotes", () => {
  assert.equal(csvCell(" =1+1"), '"\' =1+1"');
  assert.equal(csvCell('Nome "A"'), '"Nome ""A"""');
  assert.equal(csvCell("\t=1"), '"\'\t=1"');
});
