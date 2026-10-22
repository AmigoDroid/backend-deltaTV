import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/shared/errors.js";
import { isPrivateAddress } from "../../src/shared/ssrf.js";
import { normalizeRokuRegistration } from "../../src/modules/devices/registration.service.js";

test("Roku installationId is bound to the normalized MAC", () => {
  assert.deepEqual(
    normalizeRokuRegistration("aa-bb-cc-dd-ee-ff", "roku-AABBCCDDEEFF"),
    { mac: "AA:BB:CC:DD:EE:FF", installationId: "roku-AABBCCDDEEFF" },
  );
  assert.throws(
    () => normalizeRokuRegistration("AA:BB:CC:DD:EE:FF", "roku-aabbccddeeff"),
    (error) => error instanceof AppError && error.code === "INSTALLATION_ID_MISMATCH",
  );
  assert.throws(
    () => normalizeRokuRegistration("not-a-mac", "roku-AABBCCDDEEFF"),
    (error) => error instanceof AppError && error.code === "INVALID_MAC",
  );
});

test("SSRF address policy rejects special and reserved networks but permits global addresses", () => {
  for (const address of [
    "0.1.2.3", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
    "172.31.1.1", "192.0.0.8", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.2", "203.0.113.8", "224.0.0.1", "::1", "fc00::1",
    "fe80::1", "2001:db8::1", "2002::1", "::ffff:10.1.2.3",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});
