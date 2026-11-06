"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const routesFile = path.resolve(__dirname, "../../src/modules/profile/profile.routes.js");
const code = fs.readFileSync(routesFile, "utf8");
const imports = [...code.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];/g)].map(m => ({ spec: m[2], names: m[1].split(",").map(p => p.trim().split(/\s+as\s+/)[0]) }));
// Import default Router represented separately.

async function makeProfile() {
  const routes = {}, audits = [], sessions = [], disconnects = [];
  const zType = new Proxy({}, { get: (_o, k) => (...args) => zType });
  const z = { object: () => zType, string: () => zType, boolean: () => zType, coerce: { number: () => zType } };
  let patches = [];
  const models = {
    sequelize: {
      transaction: fn => fn({ LOCK: { UPDATE: true } }),
      where: (...args) => args, fn: () => "lower", col: () => "email",
    },
    AdminUser: { findByPk: async () => ({ id: "u1", name: "User", email: "user@test.local", role: "partner", lastLoginAt: null,
      passwordHash: "hidden", update: async patch => { patches.push(patch); } }), findOne: async () => null },
    AdminUserProfile: { findByPk: async () => null, bulkCreate: async (rows, opts) => { sessions.push({ rows, opts }); } },
    Partner: { findByPk: async () => ({ id: "p1", name: "Partner", status: "active", kind: "both" }) },
    AuthSession: {
      findAndCountAll: async () => ({ rows: [], count: 0 }),
      update: async (_patch, options) => { sessions.push(options.where); return [2]; },
    },
    AuditLog: { findAndCountAll: async () => ({ rows: [], count: 0 }) },
    LoginHistory: { findAndCountAll: async () => ({ rows: [], count: 0 }) },
  };
  const router = { use: () => {}, get: (p,...handlers) => { routes[`GET ${p}`] = handlers.at(-1); },
    patch: (p,...handlers) => { routes[`PATCH ${p}`] = handlers.at(-1); },
    post: (p,...handlers) => { routes[`POST ${p}`] = handlers.at(-1); },
    delete: (p,...handlers) => { routes[`DELETE ${p}`] = handlers.at(-1); } };
  const stubs = {
    express: { Router: () => router }, zod: { z }, sequelize: { Op: { gt: "gt", ne: "ne" }, UniqueConstraintError: class extends Error {} },
    "../../db/models/index.js": models,
    "../../middleware/authenticate.js": { authenticate: () => {}, requirePartnerRole: () => {} },
    "../../shared/validate.js": { validate: () => () => {} },
    "../../shared/errors.js": { AppError: class AppError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } } },
    "../../shared/audit.js": { actorOf: req => ({ type: "partner", id: req.user.id }), audit: async value => audits.push(value) },
    "../../shared/crypto.js": { verifyPassword: async x => x === "right" },
    "../../middleware/security.js": { profileSensitiveLimiter: () => {} },
    "../auth/auth.service.js": { revokeAllSessions: async id => sessions.push({ all: id }) },
    "../../realtime/socket.js": { disconnectAdminUser: id => disconnects.push({ all: id }), disconnectAdminSession: (...args) => disconnects.push(args) },
  };
  const context = vm.createContext({ Buffer, console, Date, Object, Set, Math });
  const main = new vm.SourceTextModule(code, { context, identifier: routesFile });
  await main.link(spec => {
    const names = imports.find(i => i.spec === spec)?.names || (spec === "express" ? ["Router"] : []);
    if (!stubs[spec]) throw Error(spec);
    return new vm.SyntheticModule(names, function () { for (const name of names) this.setExport(name, stubs[spec][name]); }, { context });
  });
  await main.evaluate();
  return { routes, audits, sessions, disconnects, module: main.namespace, patches };
}
const req = () => ({ user: { id: "u1", partnerId: "p1", role: "partner" }, sessionId: "current-session", valid: { body: {}, params: {}, query: { page: 1, limit: 10 } } });
const res = () => ({ output: null, json(value) { this.output = value; return this; }, set() { return this; } });

test("rotas do perfil são privadas e retornam apenas campos públicos", async () => {
  const x = await makeProfile();
  const reply = res(); await x.routes["GET /"](req(), reply);
  assert.equal(reply.output.user.name, "User");
  assert.equal(JSON.stringify(reply.output).includes("hidden"), false);
  assert.equal(reply.output.profile.showUnreadBanner, true);
});

test("avatar não aceita SVG, MIME forjado, arquivo grande nem base64 truncado", async () => {
  const x = await makeProfile();
  const valid = "data:image/png;base64," + Buffer.from("89504e470d0a1a0a0000000000000000000000000000000000", "hex").toString("base64");
  assert.equal(x.module.validateAvatarData(valid), valid);
  assert.equal(x.module.validateAvatarData(null), null);
  for (const sample of ["data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"),
    "data:image/png;base64," + Buffer.from("not a png").toString("base64"),
    "data:image/jpeg;base64," + "A".repeat(131080)])
    assert.throws(() => x.module.validateAvatarData(sample), { code: "INVALID_AVATAR" });
});

test("trocar avatar NÃO reseta preferências já salvas", async () => {
  const x = await makeProfile(); const request = req();
  request.valid.body = { avatarData: null }; const reply = res();
  await x.routes["PATCH /avatar"](request, reply);
  assert.equal(reply.output.ok, true);
  assert.deepEqual(Array.from(x.sessions.at(-1).opts.updateOnDuplicate), ["avatarData", "updatedAt"]);
  assert.ok(x.sessions.at(-1).rows[0].updatedAt instanceof Date);
  assert.equal(x.audits.at(-1).action, "profile.avatar.change");
});

test("revogar outras sessões preserva o id da sessão atual", async () => {
  const x = await makeProfile(); const reply = res();
  await x.routes["POST /sessions/revoke-others"](req(), reply);
  assert.equal(reply.output.revoked, 2);
  assert.equal(x.sessions[0].id.ne, "current-session");
  assert.equal(JSON.stringify(x.disconnects[0]), JSON.stringify(["u1", "current-session", { except: true }]));
});

test("revogar sessão específica restringe a conta ao próprio titular", async () => {
  const x = await makeProfile(); const request = req(); request.valid.params.id = "another-session";
  const reply = res(); await x.routes["DELETE /sessions/:id"](request, reply);
  assert.equal(x.sessions[0].adminUserId, "u1");
  assert.equal(reply.output.currentSessionRevoked, false);
  assert.deepEqual(x.disconnects[0], ["u1", "another-session"]);
});

test("revisão de atividade usa actorId do token, sem aceitar outros usuários", async () => {
  const x = await makeProfile(); const reply = res();
  await x.routes["GET /activity"](req(), reply);
  assert.equal(reply.output.meta.total, 0);
  assert.match(code, /actorId:\s*String\(req\.user\.id\)/);
});
