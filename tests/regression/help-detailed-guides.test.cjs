'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('../../src/db/migrations/20261203000001-help-detailed-guides.cjs');
const basedir = path.resolve(__dirname, '../../');
const read = rel => fs.readFileSync(path.join(basedir, rel), 'utf8');

test('roteiros detalhados contemplam Roku QR, controle, múltiplas listas, white-label e erros', () => {
 const { guides, upgrades } = migration._test;
 assert.equal(guides.length, 5);
 assert.equal(upgrades.length, 7);
 for (const name of ['roku-delta-qr','roku-delta-controle','roku-delta-varias-listas','roku-white-label-login','roku-problemas-de-conexao']) {
   const item = guides.find(g => g.slug === name);
   assert.ok(item && item.steps.length >= 6);
   assert.equal(item.category, 'Configurar TV');
   assert.ok(item.steps.every(s => s.mode === 'external' && s.tip && s.body.length >= 25));
   assert.ok(item.steps.length <= 16);
 }
 const branded = guides.find(g => g.slug === 'roku-white-label-login');
 assert.match(branded.body, /usuário e senha/);
 assert.match(branded.body, /cadastra os servidores/);
});

test('migração preserva tutoriais personalizados e não reinsere o mesmo slug', async () => {
 const updates = [], inserts = [], deleted = [];
 const initial = migration._test.guides[0];
 const q = { sequelize: { transaction: fn => fn({}), query: async (sql, opts) => { if(sql.startsWith('UPDATE')) updates.push([sql,opts]); if(sql.startsWith('DELETE')) deleted.push([sql,opts]); return sql.startsWith('SELECT') ? [[{ slug: initial.slug }], {}] : [[],{}]; } },
   bulkInsert: async (...args) => inserts.push(args),
 };
 await migration.up(q);
 assert.equal(updates.length, 7);
 assert.ok(updates.every(c => c[0].includes('updated_at = created_at') && c[1].replacements.oldBody.length > 30));
 assert.equal(inserts.length, 1);
 assert.equal(inserts[0][1].length, 4);
 assert.ok(inserts[0][1].every(g => g.status === 'published' && Array.isArray(JSON.parse(g.steps))));
 await migration.down(q);
 assert.equal(deleted.length, 5);
 assert.ok(deleted.every(c => c[0].includes('updated_at = created_at')));
});

test('backend permite campos de conferência e ações externas sem seletores arbitrários', () => {
 const schema = read('src/modules/help/help.schemas.js');
 assert.match(schema, /mode: z\.enum\(\["panel", "external"\]\)/);
 assert.match(schema, /tip: z\.string\(\)\.trim\(\)\.max\(360\)/);
 assert.match(schema, /\.strict\(\)/);
 assert.match(schema, /context-help/);
});
