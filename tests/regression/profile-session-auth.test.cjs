"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const sourcePath = path.resolve(__dirname, "../../src/middleware/authenticate.js");
const source = fs.readFileSync(sourcePath, "utf8");
const imports = [...source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];/g)].map(m => ({ spec: m[2], names: m[1].split(",").map(p => p.trim()) }));
async function createAuth({ sessionActive = true, sid = "session-xyz" } = {}) {
  let lookedUp = null;
  const stubs = {
    sequelize: { Op: { or: "or", lt: "lt", gt: "gt" } },
    "../db/models/index.js": {
      AdminUser: { findByPk: async () => ({ id: "u1", role: "admin", status: "active", tokenVersion: 3 }) },
      AuthSession: { findOne: async opts => { lookedUp = opts; return sessionActive ? { id: sid } : null; } },
    },
    "../shared/crypto.js": { verifyJwt: () => ({ sub: "u1", tv: 3, sid }) },
    "../shared/errors.js": { AppError: class AppError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } } },
  };
  const context = vm.createContext({ Date, console });
  const main = new vm.SourceTextModule(source, { context });
  await main.link(spec => new vm.SyntheticModule(imports.find(i => i.spec === spec).names, function () {
    for (const name of imports.find(i => i.spec === spec).names) this.setExport(name, stubs[spec][name]);
  }, { context }));
  await main.evaluate();
  return { authenticate: main.namespace.authenticate, lookup: () => lookedUp };
}
function request() { return { get: () => "Bearer signed.jwt.token" }; }
test("JWT com sid verifica sessão válida e registra id na requisição", async () => {
  const { authenticate, lookup } = await createAuth();
  const r = request(); let called = false;
  await authenticate(r, {}, () => { called = true; });
  assert.equal(called, true); assert.equal(r.sessionId, "session-xyz");
  assert.equal(lookup().where.adminUserId, "u1");
  assert.equal(lookup().where.revokedAt, null);
});
test("JWT com sessão revogada recusa autorização, mesmo se token não expirou", async () => {
  const { authenticate } = await createAuth({ sessionActive: false });
  await assert.rejects(() => authenticate(request(), {}, () => {}), { code: "INVALID_TOKEN" });
});
