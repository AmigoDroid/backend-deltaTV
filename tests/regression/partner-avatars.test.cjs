"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const file = path.resolve(__dirname, "../../src/modules/partners/partner-avatar.service.js");
const source = fs.readFileSync(file, "utf8");

async function load(candidates = [], profiles = []) {
  const calls = [];
  const models = {
    sequelize: { query: async (sql, opts) => { calls.push({ sql, opts }); return candidates; } },
    Partner: { findAll: async opts => {
      calls.push({ partnerOpts: opts });
      return [{ id: "partner-a", contactEmail: "contact@domain.test" }, { id: "partner-b", contactEmail: null }];
    } },
    AdminUserProfile: { findAll: async opts => { calls.push({ profileOpts: opts }); return profiles; } },
  };
  const ctx = vm.createContext({ Map, Date, Set });
  const mod = new vm.SourceTextModule(source, { context: ctx, identifier: file });
  await mod.link(spec => {
    const obj = spec === "sequelize" ? { Op: { in: Symbol("in"), ne: Symbol("ne") }, QueryTypes: { SELECT: "SELECT" } } : models;
    return new vm.SyntheticModule(Object.keys(obj), function () {
      for (const k of Object.keys(obj)) this.setExport(k, obj[k]);
    }, { context: ctx });
  });
  await mod.evaluate();
  return { ...mod.namespace, calls };
}

const stamp = "2026-11-06T09:00:00.000Z";
const partnerA = { id: "partner-a", contactEmail: "CONTACT@domain.test" };
const partnerB = { id: "partner-b", contactEmail: null };
const candidate = (userId, partnerId, email, createdAt) => ({ userId, partnerId, email, createdAt, avatarUpdatedAt: stamp });

test("prioriza o perfil ativo com foto cujo e-mail coincide com contato, ainda que não seja o mais antigo", async () => {
  const m = await load();
  const result = m.selectAvatarOwners([partnerA, partnerB], [
    candidate("u1", "partner-a", "other@test.local", "2025-01-01"),
    candidate("u2", "partner-a", "contact@domain.test", "2026-01-01"),
    candidate("u3", "partner-b", "reseller@test.local", "2025-02-01"),
  ]);
  assert.equal(result.get("partner-a").userId, "u2");
  assert.equal(result.get("partner-b").userId, "u3");
});

test("preferência estável para parceiros com vários usuários sem e-mail principal", async () => {
  const m = await load();
  const users = [candidate("u2", "partner-b", "2@test.local", "2026-01-01"), candidate("u1", "partner-b", "1@test.local", "2024-01-01")];
  const a = m.selectAvatarOwners([partnerB], users);
  const b = m.selectAvatarOwners([partnerB], users.slice().reverse());
  assert.equal(a.get("partner-b").userId, "u1");
  assert.equal(a.get("partner-b").userId, b.get("partner-b").userId);
});

test("fotos de pessoas de outros parceiros e perfis sem foto não aparecem", async () => {
  const m = await load();
  const matches = m.selectAvatarOwners([partnerA], [candidate("foreign", "partner-b", "x@y.test", "2024-01-01"),
    { ...candidate("empty", "partner-a", "x@y.test", "2024-01-01"), avatarUpdatedAt: null }]);
  assert.equal(matches.size, 0);
});

test("listagem busca metadados sem transferir avatarData e filtra contas ativas", async () => {
  const m = await load([]);
  assert.equal((await m.findAvatarOwners([partnerA])).size, 0);
  const query = m.calls[0];
  assert.match(query.sql, /role = 'partner' AND u.status = 'active'/);
  assert.match(query.sql, /p.avatar_data IS NOT NULL/);
  assert.doesNotMatch(query.sql, /SELECT\s+.*avatar_data/i);
  assert.equal(query.opts.type, "SELECT");
  assert.equal(Array.from(query.opts.replacements.partnerIds)[0], "partner-a");
});

test("busca de fotos só consulta perfis escolhidos e retorna revisão consistente", async () => {
  const users = [candidate("user-a", "partner-a", "contact@domain.test", "2026-01-01"),
    candidate("user-b", "partner-b", "b@test.local", "2026-01-01")];
  const profiles = [
    { adminUserId: "user-a", avatarData: "data:image/png;base64,AAE=", updatedAt: new Date(stamp) },
    { adminUserId: "user-b", avatarData: "data:image/svg+xml;base64,PHN2Zz4=", updatedAt: new Date(stamp) },
  ];
  const m = await load(users, profiles);
  const out = await m.getPartnerAvatarImages(["partner-a", "partner-b"]);
  assert.equal(out.length, 1); // rejeita SVG, inclusive se houver dados antigos inválidos
  assert.equal(out[0].partnerId, "partner-a");
  assert.equal(out[0].avatarVersion, `user-a:${stamp}`);
  const query = m.calls.find(c => c.profileOpts);
  assert.equal(query.profileOpts.attributes.join(","), "adminUserId,avatarData,updatedAt");
  assert.equal(Array.from(query.profileOpts.where.adminUserId[Object.getOwnPropertySymbols(query.profileOpts.where.adminUserId)[0]]).length, 2);
});

test("mudar foto altera a revisão para não exibir cache antigo", async () => {
  const m = await load();
  assert.notEqual(m.avatarVersion({ userId: "u", avatarUpdatedAt: stamp }),
    m.avatarVersion({ userId: "u", avatarUpdatedAt: "2026-11-06T09:00:02.000Z" }));
  assert.equal(m.avatarVersion(null), null);
});
