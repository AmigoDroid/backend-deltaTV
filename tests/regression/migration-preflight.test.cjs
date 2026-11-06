"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const migration = require("../../src/db/migrations/20261126000001-pix-refund-cases.cjs");

function fakeMigration(existing = false) {
  const actions = [];
  const schema = {
    UUID: "UUID", UUIDV4: "UUIDV4", INTEGER: "INTEGER", TEXT: "TEXT", DATE: "DATE",
    STRING: (n) => `STRING(${n})`, literal: (v) => v,
  };
  const q = {
    async createTable(name, _fields, options) { actions.push(["create", name]); assert.ok(options.transaction); },
    async describeTable() { if (!existing) throw new Error("not found"); return { id: {} }; },
    sequelize: {
      async transaction(fn) { actions.push(["begin"]); await fn({ id: "transaction" }); actions.push(["commit"]); },
      async query(sql, options) { actions.push(["sql", sql]); assert.ok(options.transaction); },
    },
  };
  return { q, schema, actions };
}

test("migration cria esquema e carga legada na mesma transação sem extensão de UUID", async () => {
  const { q, schema, actions } = fakeMigration();
  await migration.up(q, schema);
  assert.deepEqual(actions.map((a) => a[0]), ["begin", "create", "sql", "sql", "commit"]);
  assert.match(actions.at(-2)[1], /md5\('deltatv-pix-refund:' \|\| id::text\)::uuid/);
  assert.doesNotMatch(actions.at(-2)[1], /gen_random_uuid/);
});

test("migration pode continuar com tabela já criada parcialmente", async () => {
  const { q, schema, actions } = fakeMigration(true);
  await migration.up(q, schema);
  assert.equal(actions.some(([type]) => type === "create"), false);
  assert.equal(actions.filter(([type]) => type === "sql").length, 2);
});

test("pré-verificação recusa esquema incompleto antes de abrir HTTP", async () => {
  const { verifyRequiredSchema } = await import(path.resolve(__dirname, "../../src/db/schema-preflight.js"));
  const tables = {
    white_label_apps: { id: {}, partner_id: {}, app_key: {}, plan_type: {}, activation_limit: {}, monthly_fee_cents: {}, paid_through: {} },
    white_label_app_servers: { app_id: {}, base_url: {}, status: {} },
    white_label_app_activations: { app_id: {}, installation_hash: {}, status: {} },
    white_label_app_payments: { app_id: {}, reference: {}, months: {}, paid_through: {} },
    admin_users: { id: {}, password_reset_hash: {}, password_reset_expires_at: {}, password_reset_issued_at: {} },
    pix_refund_cases: { id: {}, charge_id: {}, amount_cents: {}, status: {} },
    admin_user_profiles: { admin_user_id: {}, phone: {}, avatar_data: {}, show_unread_banner: {}, show_notification_badge: {} },
    web_accesses: { id: {}, status: {}, status_reason: {}, content_owner_partner_id: {}, source_partner_code_id: {} },
    partner_trash_snapshots: { partner_id: {}, previous_status: {}, users: {}, codes: {}, providers: {}, web_accesses: {} },
  };
  const qi = { async describeTable(table) {
    if (!tables[table]) throw new Error("relation does not exist");
    return tables[table];
  } };
  assert.equal(await verifyRequiredSchema({ getQueryInterface: () => qi }), true);
  delete tables.pix_refund_cases;
  await assert.rejects(() => verifyRequiredSchema({ getQueryInterface: () => qi }), /npm run db:migrate/);
});
