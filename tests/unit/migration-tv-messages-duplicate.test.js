import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const dir = new URL("../../src/db/migrations/", import.meta.url);
const migration = require("../../src/db/migrations/20261217000001-tv-messages.cjs");

const fakeQ = (columns) => {
  const calls = [];
  return { calls, sequelize: { QueryTypes: { SELECT: "SELECT" }, query: async (sql) => { calls.push(sql); return columns.map((column_name) => ({ column_name })); } } };
};

test("20261217 não altera o banco em nenhum esquema (legado, novo ou ausente) e nunca falha", async () => {
  for (const cols of [["id", "sender_id", "partner_id", "payload_hash"], ["id", "sender_user_id", "request_hash"], []]) {
    const q = fakeQ(cols);
    const log = console.log, warn = console.warn; console.log = console.warn = () => {};
    try { await migration.up(q); await migration.down(q); } finally { console.log = log; console.warn = warn; }
    assert.equal(q.calls.length, 1, "só a consulta de leitura");
    assert.match(q.calls[0], /^\s*SELECT/i);
  }
});

test("nenhuma tabela é criada por duas migrações diferentes", () => {
  const seen = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".cjs"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?|createTable\(\s*['"]([a-z_]+)/gi)) {
      const t = (m[1] || m[2]).toLowerCase();
      assert.ok(!seen.has(t) || seen.get(t) === f, `tabela ${t} criada em ${seen.get(t)} e ${f}`);
      seen.set(t, f);
    }
  }
});

test("rotas de mensagens para TV estão montadas no app (esquema legado)", () => {
  const app = readFileSync(new URL("../../src/app.js", import.meta.url), "utf8");
  assert.match(app, /app\.use\("\/api\/v1\/tv-messages",\s*panelMessages\)/);
  assert.match(app, /app\.use\("\/api\/v1\/client\/messages",\s*clientMessages\)/);
  assert.ok(app.indexOf('"/api/v1/client/messages"') < app.indexOf('app.use("/api/v1/client", clientRoutes)'));
});
