"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const file = path.resolve(__dirname, "../../src/modules/partner-trash.service.js");
const source = fs.readFileSync(file, "utf8");
const migration = require("../../src/db/migrations/20261129000001-partner-trash.cjs");
const superadmin = { role: "superadmin", id: "admin-1", type: "admin" };

async function load({ snapshot = null, counts = {}, status = "deleted" } = {}) {
  const sql = [], audits = [], cache = [];
  const partner = { id: "00000000-0000-4000-8000-000000000001", name: "Revenda teste", slug: "revenda-teste", kind: "reseller", status,
    statusReason: "Excluído", async update(values) { Object.assign(this, values); }, toJSON() { return { ...this }; } };
  const defaults = { users: 1, codes: 1, providers: 1, clients: 0, activations: 0, licenses: 0, webAccesses: 0,
    invoices: 0, payments: 0, pixCharges: 0, openRefunds: 0, openPix: 0, stockMovements: 0, creditMovements: 0,
    stockBalances: 0, creditBalances: 0, codeBalances: 0,
    otherPartnerActivations: 0, otherPartnerWebAccesses: 0, otherPartnerServerPools: 0,
    unownedCreatorLicenses: 0, otherCreatorPixCharges: 0,
    sharedStockReferences: 0, hasRestoreSnapshot: !!snapshot };
  const sequelize = {
    async transaction(fn) { return fn({ LOCK: { UPDATE: "UPDATE" } }); },
    async query(query, opts) {
      sql.push(query);
      if (query.includes('AS "openPix"')) return [{ ...defaults, ...counts }];
      if (query.startsWith('SELECT * FROM partner_trash_snapshots')) return snapshot ? [snapshot] : [];
      if (query.startsWith('WITH removed AS')) return [{ n: 1 }];
      return [];
    },
  };
  const AppError = class AppError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } };
  const exportsByPath = {
    sequelize: { Op: { in: Symbol("in"), or: Symbol("or"), iLike: Symbol("iLike") }, QueryTypes: { SELECT: "SELECT" }, ForeignKeyConstraintError: class ForeignKeyConstraintError extends Error {} },
    "../db/models/index.js": { sequelize, Partner: { findByPk: async () => partner, findAndCountAll: async () => ({ rows: [partner], count: 1 }) }, AdminUser: {} },
    "../shared/errors.js": { AppError, notFound: thing => new Error("Missing " + thing) },
    "../shared/audit.js": { audit: async event => audits.push(event) },
    "./mirror/mirror.cache.js": { clearMirrorAuth: () => cache.push('mirror') },
    "./access/access.service.js": { clearContractAccessCache: () => cache.push('access') },
    "./provider-monitor/resolve.service.js": { clearResolutionCache: () => cache.push('resolve') },
    "./devices/presence.js": { forgetDevice: () => cache.push('device') },
    "../realtime/socket.js": { disconnectPartner: () => cache.push('disconnect'), broadcastChange: () => cache.push('broadcast') },
    "./partner-deletion-confirmation.js": { matchesPartnerDeletionConfirmation: (input, p) => input === p.slug || input === p.name },
    "../shared/pagination.js": { paged: (data, total) => ({ data, total }), pageOf: () => ({}) },
  };
  const context = vm.createContext({ Date, JSON, Object, Number, String, Set, Boolean });
  const mod = new vm.SourceTextModule(source, { context, identifier: file });
  await mod.link(spec => {
    const obj = spec === 'sequelize' ? exportsByPath.sequelize : exportsByPath[spec];
    assert.ok(obj, `Unmocked import ${spec}`);
    return new vm.SyntheticModule(Object.keys(obj), function () { for (const key of Object.keys(obj)) this.setExport(key, obj[key]); }, { context });
  });
  await mod.evaluate();
  return { svc: mod.namespace, partner, sql, audits, cache };
}

const deletionInput = { phrase: "EXCLUIR DEFINITIVAMENTE", confirmSlug: "revenda-teste", reason: "Solicitação definitiva do responsável", purgeFinancialHistory: true };

test("migration cria fotografia transacional com FK CASCADE e sem segredos", async () => {
  const calls = [], transaction = { id: "tx" }, S = { UUID: "UUID", DATE: "DATE", JSONB: "JSONB", STRING: n => `STRING(${n})`, literal: x => x };
  const q = { sequelize: { transaction: async fn => { calls.push('begin'); await fn(transaction); calls.push('commit'); } },
    createTable: async (name, fields, opts) => {
      calls.push('create'); assert.equal(opts.transaction, transaction); assert.equal(name, 'partner_trash_snapshots');
      assert.equal(fields.partner_id.onDelete, 'CASCADE'); assert.ok(!Object.keys(fields).some(key => /password|token/i.test(key)));
    }, addIndex: async (_table, _fields, opts) => { calls.push('index'); assert.equal(opts.transaction, transaction); } };
  await migration.up(q, S);
  assert.deepEqual(calls, ['begin', 'create', 'index', 'commit']);
});

test("acesso à lixeira exige superadmin", async () => {
  const { svc } = await load();
  await assert.rejects(() => svc.trashPreview('id', { role: 'admin' }), error => error.code === 'SUPERADMIN_ONLY');
  await assert.rejects(() => svc.permanentlyDeletePartner('id', deletionInput, { role: 'admin' }), error => error.code === 'SUPERADMIN_ONLY');
});

test("arquivamento anterior sem fotografia restaura BLOQUEADO e não ativa usuários", async () => {
  const { svc, partner, sql, audits, cache } = await load();
  const r = await svc.restorePartnerFromTrash(partner.id, { reason: 'Reabertura solicitada' }, superadmin);
  assert.equal(r.status, 'blocked'); assert.equal(r.needsManualReview, true); assert.equal(partner.status, 'blocked');
  assert.equal(sql.some(x => x.includes('UPDATE admin_users item')), false);
  assert.equal(audits[0].action, 'partner.restore.admin'); assert.ok(cache.includes('disconnect'));
});

test("restauração usa apenas fotografia de estados anteriores e encerra sessões", async () => {
  const snapshot = { previous_status: 'active', previous_status_reason: null,
    users: [{ id: 'u', status: 'active' }], codes: [{ id: 'c', status: 'active' }],
    providers: [{ id: 'p', status: 'active' }], web_accesses: [{ id: 'w', status: 'active', statusReason: null }] };
  const { svc, partner, sql } = await load({ snapshot });
  const r = await svc.restorePartnerFromTrash(partner.id, { reason: 'Cadastro restaurado' }, superadmin);
  assert.equal(r.needsManualReview, false); assert.equal(partner.status, 'active');
  assert.ok(sql.some(x => x.includes('UPDATE admin_users item SET status = restore.status')));
  assert.ok(sql.some(x => x.includes('UPDATE web_accesses item SET status = restore.status')));
});

test("não apaga sem frase exata nem motivo", async () => {
  const { svc } = await load();
  await assert.rejects(() => svc.permanentlyDeletePartner('x', { ...deletionInput, phrase: 'EXCLUIR' }, superadmin), e => e.code === 'PURGE_PHRASE');
  await assert.rejects(() => svc.permanentlyDeletePartner('x', { ...deletionInput, reason: 'curto' }, superadmin), e => e.code === 'REASON_REQUIRED');
});

test("não apaga Pix ou devoluções em aberto", async () => {
  const { svc, sql } = await load({ counts: { openPix: 1, openRefunds: 1 } });
  await assert.rejects(() => svc.permanentlyDeletePartner('x', deletionInput, superadmin), e => e.code === 'PURGE_BLOCKED');
  assert.ok(!sql.some(x => x.includes('DELETE FROM partners WHERE')));
});

test("não remove registros ligados a outras parcerias", async () => {
  const { svc, sql } = await load({ counts: { otherPartnerActivations: 1, otherPartnerWebAccesses: 2 } });
  await assert.rejects(() => svc.permanentlyDeletePartner('x', deletionInput, superadmin), e => e.code === 'PURGE_BLOCKED');
  assert.ok(!sql.some(x => x.includes('DELETE FROM partners WHERE')));
});

test("não apaga entidades compartilhadas indiretamente pelo servidor ou autor", async () => {
  const { svc, sql } = await load({ counts: { otherPartnerServerPools: 2, unownedCreatorLicenses: 1, otherCreatorPixCharges: 1 } });
  await assert.rejects(() => svc.permanentlyDeletePartner('x', deletionInput, superadmin), e => e.code === 'PURGE_BLOCKED');
  assert.equal(sql.some(q => q.includes('DELETE FROM partners WHERE')), false);
});

test("exige consentimento separado para apagar histórico financeiro", async () => {
  const { svc } = await load({ counts: { invoices: 1, pixCharges: 2 } });
  await assert.rejects(() => svc.permanentlyDeletePartner('x', { ...deletionInput, purgeFinancialHistory: false }, superadmin), e => e.code === 'FINANCIAL_CONFIRMATION_REQUIRED');
});

test("exclusão física inclui dependentes, não apaga dispositivos compartilhados e audita sem e-mail", async () => {
  const { svc, partner, sql, audits, cache } = await load({ counts: { invoices: 2 } });
  const r = await svc.permanentlyDeletePartner(partner.id, deletionInput, superadmin);
  assert.equal(r.permanentlyDeleted, true);
  for (const table of ['pix_refund_cases','pix_charges','payments','invoices','content_activation_charges','web_accesses','activations','licenses','partner_codes','partner_providers','admin_users','partners','partner_pre_registrations','login_history'])
    assert.ok(sql.some(q => q.includes('DELETE FROM ' + table)), `missing ${table}`);
  assert.ok(sql.some(q => q.includes('NOT EXISTS (SELECT 1 FROM activations a')));
  assert.equal(audits.at(-1).action, 'partner.purge.admin');
  assert.ok(!JSON.stringify(audits).includes('@'));
  assert.ok(cache.includes('disconnect'));
});
