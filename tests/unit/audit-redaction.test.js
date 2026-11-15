import test from "node:test";
import assert from "node:assert/strict";
import { maskDeep } from "../../src/shared/mask.js";
test("deep and cyclic metadata cannot leak secrets or overflow audit serialization", () => {
  const value = {};
  let next = value;
  for (let i = 0; i < 15; i++) {
    next.child = {};
    next = next.child;
  }
  next.password = "must-never-be-logged";
  assert.ok(!JSON.stringify(maskDeep(value)).includes("must-never-be-logged"));
  const cycle = {};
  cycle.child = cycle;
  assert.doesNotThrow(() => JSON.stringify(maskDeep(cycle)));
  assert.equal(
    maskDeep({ nested: { refreshToken: "secret" } }).nested.refreshToken,
    "[REDACTED]",
  );
});
