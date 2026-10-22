import test from "node:test";
import assert from "node:assert/strict";
import { normalizeIdentity, displayIdentifier, legacyRokuInstallationId } from "../../src/modules/devices/device-identity.js";

const U1 = "3f1c2a54-9d1e-4b6a-8f3d-1a2b3c4d5e6f";
const U2 = "7a9b8c7d-6e5f-4a3b-9c2d-0e1f2a3b4c5d";
const code = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };

test("Roku legado continua válido: roku-<MAC> e MAC com qualquer separador", () => {
  const a = normalizeIdentity({ platform: "roku", mac: "aa-bb-cc-dd-ee-ff", installationId: "roku-AABBCCDDEEFF" });
  assert.equal(a.mac, "AA:BB:CC:DD:EE:FF");
  assert.equal(a.deviceKey, "roku:AA:BB:CC:DD:EE:FF");
  assert.equal(a.identifierType, "virtual_mac");
  assert.equal(a.legacy, true);
  assert.equal(a.installationId, legacyRokuInstallationId("AA:BB:CC:DD:EE:FF"));
});

test("Roku: installationId divergente do MAC é recusado; MAC zerado/inválido também", () => {
  assert.equal(code(() => normalizeIdentity({ platform: "roku", mac: "AA:BB:CC:DD:EE:FF", installationId: "roku-111111111111" })), "INSTALLATION_ID_MISMATCH");
  assert.equal(code(() => normalizeIdentity({ platform: "roku", mac: "00:00:00:00:00:00" })), "INVALID_MAC");
  assert.equal(code(() => normalizeIdentity({ platform: "roku", mac: "xx" })), "INVALID_MAC");
});

test("Android/Tizen/webOS/web não exigem MAC e usam UUID de instalação", () => {
  for (const platform of ["android", "tizen", "webos", "web"]) {
    const r = normalizeIdentity({ platform, identifier: U1.toUpperCase() });
    assert.equal(r.mac, null);
    assert.equal(r.identifierType, "install_uuid");
    assert.equal(r.deviceKey, `${platform}:delta-tv-${platform}:${U1}`);
    assert.equal(r.legacy, false);
  }
});

test("mesmo UUID em plataformas/apps diferentes gera chaves diferentes", () => {
  const a = normalizeIdentity({ platform: "android", identifier: U1 }).deviceKey;
  assert.notEqual(a, normalizeIdentity({ platform: "web", identifier: U1 }).deviceKey);
  assert.notEqual(a, normalizeIdentity({ platform: "android", appId: "outro-app", identifier: U1 }).deviceKey);
  assert.notEqual(a, normalizeIdentity({ platform: "android", identifier: U2 }).deviceKey);
});

test("identificadores fracos ou fabricados são recusados", () => {
  const bads = ["", "1234", "00000000-0000-4000-8000-000000000000", "not-a-uuid", U1.replace("-4", "-1")];
  for (const identifier of bads) assert.equal(code(() => normalizeIdentity({ platform: "android", identifier })), "INVALID_IDENTIFIER", identifier);
  assert.equal(code(() => normalizeIdentity({ platform: "android" })), "INVALID_IDENTIFIER");
});

test("platform_hash exige SHA-256 hex (nunca ID cru) e rejeita tudo-zero", () => {
  const h = "a".repeat(64);
  assert.equal(normalizeIdentity({ platform: "tizen", identifierType: "platform_hash", identifier: h }).identifierType, "platform_hash");
  assert.equal(code(() => normalizeIdentity({ platform: "tizen", identifierType: "platform_hash", identifier: "TIZEN-DUID-123" })), "INVALID_IDENTIFIER");
  assert.equal(code(() => normalizeIdentity({ platform: "tizen", identifierType: "platform_hash", identifier: "0".repeat(64) })), "INVALID_IDENTIFIER");
});

test("virtual_mac fora do Roku, plataforma e appId inválidos", () => {
  assert.equal(code(() => normalizeIdentity({ platform: "android", identifierType: "virtual_mac", identifier: U1 })), "INVALID_IDENTIFIER_TYPE");
  assert.equal(code(() => normalizeIdentity({ platform: "playstation", identifier: U1 })), "INVALID_PLATFORM");
  assert.equal(code(() => normalizeIdentity({ platform: "android", appId: "Ruim App!", identifier: U1 })), "INVALID_APP_ID");
  assert.equal(code(() => normalizeIdentity(null)), "INVALID_PLATFORM");
});

test("rótulo de exibição não vaza o identificador inteiro", () => {
  assert.equal(displayIdentifier(normalizeIdentity({ platform: "roku", mac: "AA:BB:CC:DD:EE:FF" })), "AA:BB:CC:DD:EE:FF");
  const label = displayIdentifier(normalizeIdentity({ platform: "android", identifier: U1 }));
  assert.equal(label, "ANDROID-3F1C2A54");
  assert.ok(!label.toLowerCase().includes(U1.slice(9, 13)));
});
