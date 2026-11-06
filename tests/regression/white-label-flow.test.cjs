"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const file = path.resolve(__dirname, "../../src/modules/white-label/white-label.service.js");
const code = fs.readFileSync(file, "utf8");
const imports = [...code.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g)];
const rules = () => import(path.resolve(__dirname, "../../src/modules/white-label/white-label.rules.js"));

async function load({ quota = 1, valid = true, tenantId = "p1" } = {}) {
  const records = [], payments = [], events = [];
  const sessions = new Map();
  let nextId = 1;
  const app = {
    id: "app1", partnerId: tenantId, name: "Outro Player", appKey: "outro-player", status: "active",
    planType: "limited", activationLimit: quota, paidThrough: "2029-12-31", monthlyFeeCents: 2500,
    async update(patch) { Object.assign(this, patch); },
  };
  const partner = { id: tenantId, status: "active", name: "Cliente" };
  const server = { id: "url1", appId: app.id, baseUrl: "https://tv.example.org", status: "active", name: "Principal" };
  const tx = { LOCK: { UPDATE: "UPDATE" } };
  const models = {
    sequelize: { async transaction(fn) { return fn(tx); } },
    Partner: { async findByPk(id) { return id === tenantId ? partner : null; } },
    WhiteLabelApp: {
      async findOne({ where }) { return (where.appKey === app.appKey || (where.id === app.id && (!where.partnerId || where.partnerId === app.partnerId))) ? app : null; },
      async findByPk(id) { return id === app.id ? app : null; },
    },
    WhiteLabelAppServer: { async findAll() { return [server]; } },
    WhiteLabelAppActivation: {
      async findOne({ where }) { return records.find(r => r.appId === where.appId && (!where.status || where.status === r.status) && (where.installationHash ? r.installationHash === where.installationHash : r.id === where.id)) ?? null; },
      async count() { return records.filter(r => r.status === "active").length; },
      async create(input) {
        const r = { id: `activation-${nextId++}`, ...input, async update(patch) { Object.assign(this, patch); } };
        records.push(r); return r;
      },
    },
    WhiteLabelAppPayment: {
      async findOne({ where }) { return payments.find(x => x.reference === where.reference && x.appId === where.appId) ?? null; },
      async create(input) { const p = { id: `payment-${nextId++}`, ...input }; payments.push(p); return p; },
    },
  };
  const failures = class AppError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } };
  const stubs = {
    "node:crypto": { createHash: crypto.createHash },
    sequelize: { Op: {} },
    "../../db/models/index.js": models,
    "../../shared/crypto.js": {
      signJwt: (payload, ttl) => { const token = `signed-${sessions.size+1}`; sessions.set(token, payload); return token; },
      verifyJwt: (token, typ) => { const payload = sessions.get(token); if (!payload || payload.typ !== typ) throw new failures(401, "INVALID_TOKEN", "Invalid"); return payload; },
    },
    "../../shared/errors.js": { AppError: failures, notFound: which => new failures(404, "NOT_FOUND", which) },
    "../../shared/audit.js": { audit: async r => events.push(r) },
    "../../shared/pagination.js": { paged: () => {}, pageOf: () => ({}) },
    "../../shared/ssrf.js": { assertPublicUrl: async () => {} },
    "../xtream/xtream.service.js": { xtreamOrigin: x => x, probeAccount: async () => valid ? { ok: true, account: { status: "Active" } } : { ok: false, reason: "invalid" } },
    "./white-label.rules.js": await rules(),
  };
  const context = vm.createContext({ Date, JSON, Math, Number, String, console, Error, RangeError });
  const main = new vm.SourceTextModule(code, { context, identifier: file });
  await main.link(spec => {
    const record = imports.find(x => x[2] === spec);
    assert.ok(record, `Missing import: ${spec}`);
    const names = record[1].split(",").map(x => x.trim().split(/\s+as\s+/)[0]);
    assert.ok(stubs[spec], `No stub for ${spec}`);
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, stubs[spec][name]); }, { context });
  });
  await main.evaluate();
  return { service: main.namespace, app, records, payments, events };
}
const cred = id => ({ installationId: id, platform: "roku", username: "cliente", password: "senha" });
const ACTOR = { id: "super-id", role: "superadmin", type: "admin" };

test("credenciais inválidas NÃO ocupam vaga nem criam instalação", async () => {
  const { service, records } = await load({ valid: false });
  await assert.rejects(() => service.activateByXtream("outro-player", cred("installation-aaaa-0001")), e => e.code === "XTREAM_INVALID");
  assert.equal(records.length, 0);
});
test("mesmo installationId é idempotente, aparelho adicional respeita o limite", async () => {
  const { service, records } = await load();
  const first = await service.activateByXtream("outro-player", cred("installation-aaaa-0001"));
  const again = await service.activateByXtream("outro-player", cred("installation-aaaa-0001"));
  assert.equal(first.activation.id, again.activation.id);
  assert.equal(records.length, 1);
  assert.equal(first.selectedBaseUrl, "https://tv.example.org");
  assert.equal(first.servers.length, 1);
  await assert.rejects(() => service.activateByXtream("outro-player", cred("installation-bbbb-0002")), e => e.code === "ACTIVATION_LIMIT");
});
test("bloqueio remove vaga e impede reativação automática da mesma instalação", async () => {
  const { service, records } = await load();
  const first = await service.activateByXtream("outro-player", cred("installation-aaaa-0001"));
  await service.changeActivation("app1", first.activation.id, "p1", "revoke", ACTOR);
  assert.equal(records[0].status, "revoked");
  await assert.rejects(() => service.activateByXtream("outro-player", cred("installation-aaaa-0001")), e => e.code === "DEVICE_REVOKED");
  await service.activateByXtream("outro-player", cred("installation-bbbb-0002"));
  await assert.rejects(() => service.changeActivation("app1", first.activation.id, "p1", "restore", ACTOR), e => e.code === "ACTIVATION_LIMIT");
});
test("parceiro não pode operar contrato de outro cliente", async () => {
  const { service } = await load();
  await assert.rejects(() => service.changeActivation("app1", "activation", "another-tenant", "revoke", ACTOR), e => e.code === "NOT_FOUND");
});
test("registro manual de pagamento respeita idempotência e prorroga a vigência", async () => {
  const { service, app, payments, events } = await load();
  app.paidThrough = "2026-11-30";
  const input = { reference: "comprovante-123", months: 1, amountCents: 2500, notes: "transferência" };
  const a = await service.recordPayment("app1", input, ACTOR);
  assert.equal(a.paidThrough, "2026-12-31");
  assert.equal(app.paidThrough, "2026-12-31");
  const b = await service.recordPayment("app1", input, ACTOR);
  assert.equal(b.duplicate, true);
  assert.equal(payments.length, 1);
  assert.equal(events.filter(x => x.action === "white-label.payment.manual").length, 1);
});

test("referência de pagamento reutilizada com valor diferente é recusada", async () => {
  const { service, payments } = await load();
  const first = { reference: "pix-123", months: 1, amountCents: 2500 };
  await service.recordPayment("app1", first, ACTOR);
  await assert.rejects(
    () => service.recordPayment("app1", { ...first, amountCents: 2600 }, ACTOR),
    e => e.code === "PAYMENT_REFERENCE_CONFLICT",
  );
  assert.equal(payments.length, 1);
});

test("heartbeat verifica mensalidade e bloqueia sessão quando instalação é revogada", async () => {
  const { service, app } = await load();
  const login = await service.activateByXtream("outro-player", cred("installation-aaaa-0001"));
  assert.ok(login.sessionToken);
  const first = await service.validateAppSession("outro-player", login.sessionToken);
  assert.equal(first.authorized, true);
  await service.changeActivation("app1", login.activation.id, "p1", "revoke", ACTOR);
  await assert.rejects(() => service.validateAppSession("outro-player", first.sessionToken), e => e.code === "DEVICE_REVOKED");
  app.paidThrough = "2020-01-01";
  await assert.rejects(() => service.validateAppSession("outro-player", first.sessionToken), e => e.code === "APP_SUBSCRIPTION_INACTIVE");
});
