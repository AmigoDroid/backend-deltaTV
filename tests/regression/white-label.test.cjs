"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const migration = require("../../src/db/migrations/20261130000001-white-label-apps.cjs");
const root = path.resolve(__dirname, "../../src");
const from = name => fs.readFileSync(path.join(root, name), "utf8");

const rules = () => import(path.join(root, "modules/white-label/white-label.rules.js"));
test("plano mensal paga o mês corrente, estende e cruza dezembro", async () => {
  const { extendMonthlyAccess } = await rules();
  const now = new Date("2026-11-06T16:00:00Z");
  assert.equal(extendMonthlyAccess(null, 1, now), "2026-11-30");
  assert.equal(extendMonthlyAccess("2026-11-30", 1, now), "2026-12-31");
  assert.equal(extendMonthlyAccess("2026-11-30", 2, now), "2027-01-31");
  assert.equal(extendMonthlyAccess("2026-02-28", 1, new Date("2026-02-02T12:00:00Z")), "2026-03-31");
  assert.equal(extendMonthlyAccess("2025-07-31", 1, now), "2026-11-30");
  assert.throws(() => extendMonthlyAccess(null, 25, now), RangeError);
});
test("estados isolados: mensalidade, titular suspenso e aplicativo arquivado", async () => {
  const { effectiveAppState } = await rules();
  const today = new Date("2026-11-06T16:00:00Z");
  assert.equal(effectiveAppState({ status: "active", paidThrough: "2026-11-30" }, "active", today), "active");
  assert.equal(effectiveAppState({ status: "active", paidThrough: "2026-10-31" }, "active", today), "payment_required");
  assert.equal(effectiveAppState({ status: "draft", paidThrough: "2027-12-31" }, "active", today), "draft");
  assert.equal(effectiveAppState({ status: "active", paidThrough: "2027-12-31" }, "suspended", today), "owner_inactive");
  assert.equal(effectiveAppState({ status: "active", paidThrough: null }, "active", today), "payment_required");
});
test("migration cria tabelas relacionadas e UNIQUE para apps, instalações e pagamentos", async () => {
  const events = [];
  const t = { id: "transação" };
  const q = {
    sequelize: { transaction: async callback => { events.push("begin"); await callback(t); events.push("commit"); }, query: async (sql, opts) => { assert.equal(opts.transaction, t); events.push("sql:" + sql); } },
    createTable: async (name, cols, opts) => { assert.equal(opts.transaction, t); events.push("table:" + name); if (name === "white_label_apps") {
      assert.equal(cols.partner_id.onDelete, "CASCADE"); assert.equal(cols.app_key.unique, true);
      assert.equal(cols.paid_through.type, "dateonly");
    } },
    addIndex: async (table, fields, opts) => { assert.equal(opts.transaction, t); events.push("index:" + opts.name); },
    dropTable: async () => {},
  };
  const S = { UUID: "uuid", UUIDV4: "uuid4", STRING: x => `str(${x})`, INTEGER: "int", DATE: "date", DATEONLY: "dateonly", TEXT: "text", CHAR: x => `char(${x})`, literal: x => x };
  await migration.up(q, S);
  assert.equal(events.at(-1), "commit");
  assert.equal(events.filter(x => x.startsWith("table:")).length, 4);
  assert.ok(events.some(x => x === "index:ux_white_label_installation"));
  assert.ok(events.some(x => x === "index:ux_white_label_payment_ref"));
  assert.ok(events.some(x => x.includes("ck_white_label_limit")));
});
test("API pública valida senha via servidor cadastrado antes de ocupar uma vaga", () => {
  const source = from("modules/white-label/white-label.service.js");
  const probe = source.indexOf("await probeAccount");
  const tx = source.indexOf("const activation = await sequelize.transaction", probe);
  const lock = source.indexOf("lock: transaction.LOCK.UPDATE", tx);
  const quota = source.indexOf("ACTIVATION_LIMIT", lock);
  assert.ok(probe > 0 && tx > probe && lock > tx && quota > lock);
  assert.match(source, /installationHash = createHash\("sha256"\)/);
  assert.doesNotMatch(source, /credentialsEnc|passwordHash:.*password|playlistUrlEnc/);
});
test("perfil comercial não pode ser editado pelo painel do parceiro; acesso é escopado ao token", () => {
  const source = from("modules/white-label/white-label.routes.js");
  const partner = source.slice(source.indexOf("export const partnerRouter"), source.indexOf("const publicLimiter"));
  assert.ok(partner.includes("req.user.partnerId"));
  assert.doesNotMatch(partner, /partnerRouter\.patch\("\/:id"/);
  assert.doesNotMatch(partner, /partnerRouter\.post\("\/:id\/payments"/);
  assert.match(source, /requirePermission\("white-label:manage"\)/);
});
test("formulários administrativos e do cliente montados nos dois portais e Superadmin", () => {
  const apps = ["../app.js", "../modules/admin.routes.js", "../modules/portal/portal.routes.js"]
    .map(p => from(p.slice(3))); // paths sob src
  assert.ok(apps[0].includes('"/api/v1/player-apps"'));
  assert.ok(apps[1].includes('"/white-label", whiteLabelApps'));
  assert.ok(apps[2].includes('"/white-label", whiteLabelApps'));
  const parent = path.resolve(root, "../../");
  for (const page of ["admin/src/pages/WhiteLabel.jsx", "parceiro/src/WhiteLabelApps.jsx", "revenda/src/WhiteLabelApps.jsx"])
    assert.ok(fs.existsSync(path.join(parent, page)), page);
});
