import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVirtualInstallationId, sameInstallation, canonicalInstallationId, VIRTUAL_INSTALLATION_PATTERN,
} from "../src/modules/devices/device-identity.js";

const MAC = "AABBCCDDEEFF";

test("aceita os prefixos roku, rokutv, androidtv, samsungtv e lgtv", () => {
  const expected = { roku: "roku", rokutv: "roku", androidtv: "android", samsungtv: "tizen", lgtv: "webos" };
  for (const [prefix, platform] of Object.entries(expected)) {
    const p = parseVirtualInstallationId(`${prefix}-${MAC}`);
    assert.equal(p?.platform, platform, prefix);
    assert.equal(p?.compact, MAC);
    assert.ok(VIRTUAL_INSTALLATION_PATTERN.test(`${prefix}-${MAC}`));
  }
});

test("recusa prefixo desconhecido, MAC curto, minúsculas e lixo", () => {
  for (const bad of ["tizen-" + MAC, "androidtv-AABBCC", "androidtv-" + MAC.toLowerCase(), "androidtv-" + MAC + "0", MAC, "", null, undefined, "xroku-" + MAC]) {
    assert.equal(parseVirtualInstallationId(bad), null, String(bad));
  }
});

test("o mesmo MAC com prefixos diferentes é a mesma instalação", () => {
  assert.ok(sameInstallation(`roku-${MAC}`, `androidtv-${MAC}`));
  assert.ok(sameInstallation(`samsungtv-${MAC}`, `lgtv-${MAC}`));
});

test("MACs diferentes continuam sendo instalações diferentes", () => {
  assert.ok(!sameInstallation(`androidtv-${MAC}`, "androidtv-AABBCCDDEE00"));
  assert.ok(!sameInstallation(`roku-${MAC}`, "roku-112233445566"));
});

test("ids fora do formato de MAC virtual são comparados como estão", () => {
  const uuid = "3f2b8c1e-6a4d-4e7b-9c11-0d5e8a7f1234";
  assert.ok(sameInstallation(uuid, uuid));
  assert.ok(!sameInstallation(uuid, `androidtv-${MAC}`));
  assert.equal(canonicalInstallationId(uuid), uuid);
});
