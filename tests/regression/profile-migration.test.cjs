"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../../src/db/migrations/20261128000001-partner-user-profiles.cjs");

test("migração do perfil cria tabela isolada com restrição ao usuário e defaults", async () => {
  const log = [], S = { UUID: "UUID", TEXT: "TEXT", DATE: "DATE", BOOLEAN: "BOOLEAN", STRING: n => `STRING(${n})`, literal: v => v };
  const transaction = { id: "tx" };
  const q = {
    sequelize: { transaction: async cb => { log.push("begin"); await cb(transaction); log.push("commit"); } },
    createTable: async (name, fields, meta) => {
      log.push("create"); assert.equal(name, "admin_user_profiles"); assert.equal(meta.transaction, transaction);
      assert.equal(fields.admin_user_id.primaryKey, true);
      assert.equal(fields.admin_user_id.references.model, "admin_users");
      assert.equal(fields.admin_user_id.onDelete, "CASCADE");
      assert.equal(fields.show_unread_banner.defaultValue, true);
      assert.equal(fields.show_notification_badge.defaultValue, true);
    },
  };
  await migration.up(q, S);
  assert.deepEqual(log, ["begin", "create", "commit"]);
});

test("reversão retira apenas a tabela de perfis", async () => {
  let table = null;
  await migration.down({
    sequelize: { transaction: async cb => cb({ id: "tx" }) },
    dropTable: async name => { table = name; },
  });
  assert.equal(table, "admin_user_profiles");
});
