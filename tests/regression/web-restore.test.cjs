"use strict";
// Executável SEM npm install: injeta dublês das dependências ESM no código real.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");

const sourcePath = path.resolve(__dirname, "../../src/modules/web/web-access.service.js");
const source = fs.readFileSync(sourcePath, "utf8");
const allImports = [...source.matchAll(/import\s+(?:\{([\s\S]*?)\}|\*\s+as\s+\w+)\s+from\s+["']([^"']+)["'];/g)]
  .map((m) => ({ specifier: m[2], names: m[1] ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : ["configureDeviceByAdmin"] }));

async function loadService(stubs) {
  const context = vm.createContext({ console, Date, URL, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, identifier: sourcePath });
  await module.link((specifier) => {
    const imp = allImports.find((it) => it.specifier === specifier);
    assert.ok(imp, `import ${specifier}`);
    const unique = [...new Set(imp.names)];
    return new vm.SyntheticModule(unique, function () {
      for (const name of unique) this.setExport(name, stubs[specifier]?.[name]);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

function fakeEnvironment({ status = "revoked", statusReason = null, ageMs = 0, existing = null, failPreparation = false } = {}) {
  const charges = [];
  const audits = [];
  const mac = "02:AA:BB:CC:DD:EE";
  const device = { mac, id: "device-1", lastInstallationId: "webtv-02AABBCCDDEE" };
  let activation = existing;
  const wa = { id: "web-1", deviceId: device.id, status, statusReason,
    updatedAt: new Date(Date.now() - ageMs), contentOwnerPartnerId: "old-owner", sourcePartnerCodeId: "old-code",
    Device: device,
    async update(patch) { Object.assign(this, patch, { updatedAt: new Date() }); return this; },
  };
  const WebAccess = {
    async findByPk(id) { return id === wa.id ? wa : null; },
    async findOne() { return wa; },
    async update(patch, { where }) {
      if (wa.id !== where.id || wa.status !== where.status ||
          (where.statusReason !== undefined && wa.statusReason !== where.statusReason)) return [0];
      await wa.update(patch);
      return [1];
    },
  };
  const Activation = {
    async findByPk(id) { return activation?.id === id ? activation : null; },
    async findOne({ where }) {
      if (!activation) return null;
      if (where.idempotencyKey && activation.idempotencyKey !== where.idempotencyKey) return null;
      return activation;
    },
  };
  const Op = { ne: Symbol("ne"), or: Symbol("or"), iLike: Symbol("iLike"), lte: Symbol("lte") };
  const fake = {
    "node:crypto": { randomUUID },
    "../../config/env.js": { env: { nginxMediaProxy: false } },
    "../../shared/crypto.js": { decryptSecret: () => "AB123456" },
    "sequelize": { Op, UniqueConstraintError: class UniqueConstraintError extends Error {} },
    "../../db/models/index.js": {
      sequelize: { async transaction(fn) { return fn({ LOCK: { UPDATE: "UPDATE" } }); } },
      WebAccess, Device: { async findByPk() { return device; } }, Activation,
      PartnerCode: { async findByPk() { return { id: "new-code", partnerId: "new-owner" }; } },
      License: { async findByPk() { return null; } }, Partner: {}, PartnerProvider: {}, AdminUser: {}, Renewal: {}, LicenseEvent: {},
    },
    "../../shared/errors.js": { AppError: class AppError extends Error {
      constructor(status, code, message) { super(message); this.status = status; this.code = code; }
    }, notFound: (subject) => new Error(`Not found: ${subject}`) },
    "../../shared/audit.js": { audit: async (record) => { audits.push(record); } },
    "../activations/activation.service.js": {
      preparePartnerActivation: async () => {
        if (failPreparation) throw new Error("unavailable");
        return { pc: { id: "new-code" }, partner: { id: "new-owner" }, provider: { id: "server-1" }, credentialsEnc: "encrypted" };
      },
      activatePrepared: async ({ idempotencyKey }) => {
        charges.push(idempotencyKey);
        activation = { id: "act-1", deviceId: device.id, idempotencyKey: `${mac}:${idempotencyKey}`,
          providerId: "server-1", partnerId: "new-owner", partnerCodeId: "new-code", credentialsEnc: "encrypted",
          status: "active", activatedAt: new Date(), toJSON() { return { ...this }; } };
        return { activation };
      },
    },
    "../access/access.service.js": { checkActivation: async () => ({ decision: { allowed: true, code: "OK" } }) },
    "../devices/presence.js": { presenceOf: () => ({ online: false, lastSeenAt: null }) },
    "../mirror/mode.js": { deliveryModesOf: () => null },
    "../mirror/mirror.cache.js": { dropMirrorAuth: () => {}, clearMirrorAuth: () => {} },
    "../web/web-modes.js": { sanitizeModes: () => null },
    "./web-modes.js": { sanitizeModes: () => null, MODE_KINDS: [] },
    "./web-code.js": { WEB_CODE_RE: /./, generateWebCode: () => "AB123456", generateWebMac: () => mac, normalizeWebCode: (c) => c },
  };
  const stubs = new Proxy(fake, { get: (target, key) => target[key] || {} });
  return { stubs, wa, charges, audits, setActivation: (a) => { activation = a; } };
}

test("recuperação atualiza vínculo comercial e cobra uma única vez", async () => {
  const env = fakeEnvironment();
  const svc = await loadService(env.stubs);
  const result = await svc.restoreRevokedWebAccess("web-1", {
    config: { mode: "partner", code: "1234", username: "u", password: "p" }, reason: "Solicitação de recuperação" }, { id: "admin-1" });
  assert.equal(env.wa.status, "active");
  assert.equal(env.wa.contentOwnerPartnerId, "new-owner");
  assert.equal(env.wa.sourcePartnerCodeId, "new-code");
  assert.equal(env.charges.length, 1);
  assert.equal(result.activationId, "act-1");
  assert.equal(env.audits.at(-1).action, "web_access.restore");
});

test("falha no provedor não altera acesso revogado nem cobra", async () => {
  const env = fakeEnvironment({ failPreparation: true });
  const svc = await loadService(env.stubs);
  await assert.rejects(() => svc.restoreRevokedWebAccess("web-1", {
    config: { mode: "partner", code: "1234", username: "u", password: "p" }, reason: "teste" }, {}), /unavailable/);
  assert.equal(env.wa.status, "revoked");
  assert.equal(env.charges.length, 0);
});

test("retoma operação comercial já gravada sem validar Xtream nem cobrar novamente", async () => {
  const uuid = randomUUID();
  const env = fakeEnvironment({ status: "pending", statusReason: `web-restore:${uuid}`, failPreparation: true,
    existing: { id: "act-2", deviceId: "device-1", idempotencyKey: `02:AA:BB:CC:DD:EE:web-restore-${uuid}`,
      status: "active", providerId: "srv", partnerId: "new-owner", partnerCodeId: "new-code", credentialsEnc: "secret",
      toJSON() { return { ...this }; } } });
  const svc = await loadService(env.stubs);
  const result = await svc.restoreRevokedWebAccess("web-1", {
    config: { mode: "partner", code: "1234", username: "u", password: "p" }, reason: "recuperação" }, {});
  assert.equal(result.activationId, "act-2");
  assert.equal(env.wa.status, "active");
  assert.equal(env.charges.length, 0);
});

test("tentativa pendente recente não aceita reserva concorrente", async () => {
  const env = fakeEnvironment({ status: "pending", statusReason: `web-restore:${randomUUID()}` });
  const svc = await loadService(env.stubs);
  await assert.rejects(() => svc.restoreRevokedWebAccess("web-1", {
    config: { mode: "partner", code: "1234", username: "u", password: "p" }, reason: "teste" }, {}),
  (e) => e.code === "RESTORE_IN_PROGRESS");
  assert.equal(env.charges.length, 0);
});


test("reserva abandonada há 30 minutos pode ser retomada sem reutilizar a tentativa antiga", async () => {
  const previousClaim = `web-restore:${randomUUID()}`;
  const env = fakeEnvironment({ status: "pending", statusReason: previousClaim, ageMs: 31 * 60 * 1000 });
  const svc = await loadService(env.stubs);
  const result = await svc.restoreRevokedWebAccess("web-1", {
    config: { mode: "partner", code: "1234", username: "u", password: "p" }, reason: "Retomar após queda" }, {});
  assert.equal(result.activationId, "act-1");
  assert.equal(env.wa.status, "active");
  assert.notEqual(env.charges[0], `web-restore-${previousClaim.slice("web-restore:".length)}`);
  assert.ok(env.audits.some((a) => a.action === "web_access.restore_reclaim"));
  assert.equal(env.charges.length, 1);
});
