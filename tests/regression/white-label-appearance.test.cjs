'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const migration = require('../../src/db/migrations/20261201000001-white-label-appearance.cjs');
const base = path.resolve(__dirname,'../../src');
const read = name => fs.readFileSync(path.join(base,name),'utf8');

test('models and presets are distinct and a new app is disabled by default', async () => {
  const { APPEARANCE_PRESETS, applyPreset, defaultAppearance } = await import(path.join(base,'modules/white-label/appearance.presets.js'));
  assert.deepEqual(Object.keys(APPEARANCE_PRESETS),['classic','cinema','compact','minimal','mosaic','library']);
  const p = applyPreset(defaultAppearance('Meu Teste'),'cinema');
  assert.equal(p.template,'cinema');assert.equal(p.primaryColor,'#E7A94B');
  assert.equal(defaultAppearance('Test','http://unsafe.local/logo.png').logoUrl,'');
  assert.throws(()=>applyPreset(p,'missing'),RangeError);
  assert.match(read('db/models/index.js'),/appearanceEnabled: \{ type: T\.BOOLEAN, allowNull: false, defaultValue: false \}/);
});

test('migration uses a transaction and requires granted access before publication', async () => {
  const calls=[]; const tx={};
  const q={sequelize:{transaction:async fn=>{await fn(tx)} ,query:async(_sql,options)=>assert.equal(options.transaction,tx)},
    addColumn:async(t,col,attrs,options)=>{calls.push('add:'+t+'.'+col);assert.equal(options.transaction,tx);assert.equal(attrs.defaultValue,false);},
    createTable:async(name,attrs,options)=>{calls.push('table:'+name);assert.equal(options.transaction,tx);assert.equal(attrs.app_id.onDelete,'CASCADE');},
    dropTable:async()=>{},removeColumn:async()=>{}};
  const S={BOOLEAN:'bool',UUID:'uuid',JSONB:'json',INTEGER:'int',DATE:'date',literal:x=>x};
  await migration.up(q,S);
  assert.deepEqual(calls,['add:white_label_apps.appearance_enabled','table:white_label_app_appearances']);
  const s=read('modules/white-label/appearance.service.js');
  assert.match(s,/if \(partnerId && !app\.appearanceEnabled\)/);
  assert.match(s,/record\.publishedConfig/);
  assert.match(s,/publishedVersion: version/);
  assert.match(s,/entityType: 'white_label_app'/);
});

test('public route only returns published configuration and is distinct from draft updates', () => {
  const r=read('modules/white-label/white-label.routes.js');
  const publicPart=r.slice(r.indexOf('export const publicRouter'));
  const partnerPart=r.slice(r.indexOf('export const partnerRouter'),r.indexOf('const infoLimiter'));
  assert.match(publicPart,/publicRouter\.get\("\/:appKey\/appearance"/);
  assert.doesNotMatch(publicPart,/draftConfig|draft\/|publish\/|appearance-access/);
  assert.match(partnerPart,/owned\(req\)/);
  assert.match(partnerPart,/appearance\/draft/);
  assert.match(partnerPart,/appearance\/publish/);
  const adminPart=r.slice(r.indexOf('export const adminRouter'),r.indexOf('export const partnerRouter'));
  assert.match(adminPart,/appearance-access/);
});

test('Roku bundle applies three distinct layouts, polls outside the UI thread and removes bundled TMDB key', () => {
  const roku=path.resolve(__dirname,'../../../roku');
  for (const name of ['classic','cinema','compact','minimal','mosaic','library']) assert.match(fs.readFileSync(path.join(roku,'components/screens/HomeScreen.brs'),'utf8'),new RegExp('"'+name+'"'));
  assert.match(fs.readFileSync(path.join(roku,'components/tasks/AppearanceTask.xml'),'utf8'),/extends="Task"/);
  assert.match(fs.readFileSync(path.join(roku,'components/MainScene.brs'),'utf8'),/refreshWhiteLabelAppearance/);
  assert.match(fs.readFileSync(path.join(roku,'source/Config.brs'),'utf8'),/DeltaWhiteLabelAppKey\(\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(roku,'source/Config.brs'),'utf8'),/eyJhbGci/);
});

test('color contrast preserves readability and admin edits exclude feature toggle', async () => {
  const { contrastRatio } = await import(path.join(base,'modules/white-label/appearance.presets.js'));
  assert.ok(contrastRatio('#FFFFFF','#090B14') >= 4.5);
  assert.equal(Math.round(contrastRatio('#FFFFFF','#FFFFFF')), 1);
  const admin=fs.readFileSync(path.resolve(__dirname,'../../../admin/src/pages/WhiteLabel.jsx'),'utf8');
  assert.match(admin,/delete body\.appearanceEnabled/);
  const studio=fs.readFileSync(path.resolve(__dirname,'../../../parceiro/src/AppearanceStudio.jsx'),'utf8');
  const workspace=fs.readFileSync(path.resolve(__dirname,'../../../parceiro/src/StudioWorkspace.jsx'),'utf8');
  assert.match(workspace,/Baixo contraste/);
});
