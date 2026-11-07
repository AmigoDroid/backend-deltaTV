"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const migration = require("../../src/db/migrations/20261202000001-help-center.cjs");
const src = rel => fs.readFileSync(path.resolve(__dirname, "../../src", rel), "utf8");

test("migration cria catálogo, progresso individual e preferência de boas-vindas com FKs", async () => {
  const tables = {}, inserted = [], index = [], sql = [];
  const tx = Symbol("transaction");
  const q = {
    sequelize: { transaction: async fn => fn(tx), query: async (s, opts) => { assert.equal(opts.transaction, tx); sql.push(s); } },
    createTable: async (name, fields, opts) => { assert.equal(opts.transaction, tx); tables[name] = fields; },
    addIndex: async (table, columns, opts) => { assert.equal(opts.transaction, tx); index.push(opts.name); },
    bulkInsert: async (table, rows, opts) => { assert.equal(opts.transaction, tx); inserted.push(...rows); },
    dropTable: async () => {},
  };
  const S = { UUID: "uuid", STRING: n => `string${n}`, TEXT: "text", JSONB: "jsonb", BOOLEAN: "bool", INTEGER: "int", DATE: "date", literal: s => s };
  await migration.up(q, S);
  assert.deepEqual(Object.keys(tables), ["help_articles", "help_user_progress", "help_user_states"]);
  assert.equal(tables.help_user_progress.admin_user_id.onDelete, "CASCADE");
  assert.equal(tables.help_user_progress.article_id.onDelete, "CASCADE");
  assert.equal(tables.help_user_states.admin_user_id.onDelete, "CASCADE");
  assert.equal(tables.help_articles.slug.unique, true);
  assert.ok(index.includes("ix_help_articles_visible"));
  assert.ok(sql.some(x => x.includes("ck_help_article_status")));
  assert.ok(inserted.length >= 6);
  assert.equal(inserted.filter(a => a.is_onboarding).length, 1);
  assert.ok(inserted.some(a => a.audience === "reseller"));
  assert.ok(inserted.some(a => a.audience === "content"));
  for (const item of inserted) { assert.equal(item.status, "published"); assert.ok(Array.isArray(JSON.parse(item.steps))); }
});

test("tutoriais exigem autenticação e respeitam papel e tipo de parceria", () => {
  const routes = src("modules/help/help.routes.js");
  assert.match(routes, /partnerHelpRoutes\.use\(authenticate, requirePartnerRole\)/);
  assert.match(routes, /req\.user\.role !== "superadmin"/);
  assert.match(routes, /partner\.kind/);
  assert.match(routes, /status: "published"/);
  assert.match(routes, /adminUserId: req\.user\.id/);
  assert.match(routes, /progress\", validate/);
  assert.match(routes, /"Cache-Control", "no-store"/);
  assert.match(routes, /audit\(/);
  assert.doesNotMatch(routes, /eval\(|Function\(|\.querySelector/);
});

test("Zod restringe destinos guiados e URLs HTTPS", () => {
  const schemas = src("modules/help/help.schemas.js");
  assert.match(schemas, /HELP_TARGETS/);
  assert.match(schemas, /\.strict\(\)/);
  assert.match(schemas, /startsWith\("https:\/\/"\)/);
  assert.match(schemas, /\.max\(16\)/);
  assert.match(schemas, /"draft", "published", "disabled"/);
});

test("rotas registradas nos dois escopos sem endpoints públicos", () => {
  const admin = src("modules/admin.routes.js");
  const portal = src("modules/portal/portal.routes.js");
  assert.match(admin, /router\.use\("\/help", adminHelpRoutes\)/);
  assert.match(portal, /router\.use\("\/help", partnerHelpRoutes\)/);
  assert.doesNotMatch(src("app.js"), /api\/v1\/help/);
});
