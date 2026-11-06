"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const migration = require("../../src/db/migrations/20261127000001-admin-password-reset.cjs");

test("migration de recuperação cria os campos e índice na mesma transação", async () => {
  const actions = [];
  const S = { CHAR: n => `CHAR(${n})`, DATE: "DATE" };
  const q = {
    addColumn: async (table, column, opts, meta) => { assert.equal(table, "admin_users"); assert.equal(opts.allowNull, true); assert.ok(meta.transaction); actions.push(column); },
    sequelize: {
      transaction: async callback => callback({ id: "tx" }),
      query: async (sql, meta) => { assert.ok(meta.transaction); actions.push(sql); },
    },
  };
  await migration.up(q, S);
  assert.deepEqual(actions.slice(0, 3), ["password_reset_hash", "password_reset_expires_at", "password_reset_issued_at"]);
  assert.match(actions[3], /UNIQUE INDEX .*password_reset_hash.*IS NOT NULL/);
});
