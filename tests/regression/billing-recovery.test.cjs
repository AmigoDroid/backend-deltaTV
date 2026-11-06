"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const sourcePath = path.resolve(__dirname, "../../src/modules/billing/billing.service.js");
const code = fs.readFileSync(sourcePath, "utf8");
const imports = [...code.matchAll(/import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];/g)].map((m) => ({ names: m[1].split(",").map((x) => x.trim().split(/\s+as\s+/)[0]), path: m[2] }));
async function loadBilling(stubs) {
  const context = vm.createContext({ console, Date });
  const module = new vm.SourceTextModule(code, { context, identifier: sourcePath });
  await module.link((specifier) => {
    const names = imports.find((i) => i.path === specifier)?.names || [];
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, stubs[specifier]?.[name]);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
const dateHelpers = {
  currentCompetence: (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
  competenceBounds: (s) => { const [y, m] = s.split("-").map(Number); return { start: new Date(Date.UTC(y,m-1,1)), end: new Date(Date.UTC(y,m,1)) }; },
  dueDateFor: (s, d) => `${s}-${String(d).padStart(2,"0")}`,
  toDateOnly: (d) => d.toISOString().slice(0,10),
};

test("recuperação mensal cruza dezembro/janeiro e nunca inclui o mês corrente", async () => {
  const b = await loadBilling({ "../../shared/dates.js": dateHelpers,
    "sequelize": { Op: {} }, "../../db/models/index.js": {}, "../../shared/errors.js": {} });
  assert.deepEqual(Array.from(b.recoveryCompetences(new Date("2026-02-05T10:00:00Z"), 4)),
    ["2025-10", "2025-11", "2025-12", "2026-01"]);
  assert.equal(b.lastClosedCompetence(new Date("2026-01-01T00:00:00Z")), "2025-12");
  assert.throws(() => b.recoveryCompetences(new Date(), 61), /entre 1 e 60/);
});

test("backfill de fatura antiga concede prazo em vez de suspender imediatamente", async () => {
  let created = null;
  const partner = { id: "p1", startsAt: new Date("2025-01-01"), endsAt: new Date("2028-01-01"),
    billingModel: "fixed", dueDay: 10 };
  const b = await loadBilling({
    "../../shared/dates.js": dateHelpers,
    "sequelize": { Op: {} },
    "../../db/models/index.js": {
      Partner: { findByPk: async () => partner },
      Invoice: { findOne: async () => null, create: async (x) => { created = x; return { id: "i1", ...x }; } },
      sequelize: { query: async () => [[{ n: 2 }]] },
    },
    "./billing.calc.js": { calculateAmount: () => ({ amountCents: 2000, breakdown: { mode: "fixed" } }) },
    "../../shared/audit.js": { audit: async () => {} },
    "../../shared/errors.js": { AppError: class extends Error {}, notFound: () => new Error("not found") },
  });
  const r = await b.generateInvoice("p1", "2025-11", { type: "system" }, { recoveryGraceDays: 7 });
  assert.equal(r.created, true);
  assert.equal(created.breakdown.recoveredLate, true);
  assert.equal(created.breakdown.scheduledDueDate, "2025-12-10");
  assert.ok(created.dueDate > new Date().toISOString().slice(0,10));
});
