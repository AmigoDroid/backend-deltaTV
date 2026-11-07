import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPEARANCE_PRESETS, APPEARANCE_KEYS, applyPreset, defaultAppearance, contrastRatio } from '../../src/modules/white-label/appearance.presets.js';
import { TEMPLATE, filesIn, individualize } from '../../src/modules/white-label/roku-builder.core.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

// Functional package test: each new template is embedded into a real sideload source archive tree.
test('six interface presets are distinct and meet minimum contrast', () => {
  assert.deepEqual(APPEARANCE_KEYS, ['classic','cinema','compact','minimal','mosaic','library']);
  for(const id of APPEARANCE_KEYS) {
    const p=APPEARANCE_PRESETS[id];
    assert.ok(contrastRatio(p.textColor,p.panelColor)>=4.5,`panel contrast ${id}`);
    assert.ok(contrastRatio(p.textColor,p.backgroundColor)>=4.5,`bg contrast ${id}`);
    assert.equal(applyPreset(defaultAppearance('Canal Teste'),id).template,id);
  }
});

test('new layouts are included in dedicated Roku bundles and in runtime allowlist', async () => {
  const base=await filesIn(TEMPLATE);
  for(const theme of ['minimal','mosaic','library']) {
    const config=applyPreset(defaultAppearance('Demo Roku'),theme);
    const files=individualize(base, {appKey:'canal-teste',appName:'Demo Roku',appearance:config,
      edition:'dedicated',origin:'https://api.example.org',buildVersion:3});
    const get=rel=>files.find(x=>x.path===rel)?.data.toString('utf8');
    assert.match(get('source/Config.brs'),new RegExp('template: "'+theme+'"'));
    assert.match(get('components/screens/HomeScreen.brs'),new RegExp('template = "'+theme+'"'));
    assert.match(get('components/MainScene.brs'),new RegExp('config\\.template <> "'+theme+'"'));
    assert.match(get('components/screens/HomeScreen.xml'),/id="tileBg0"/);
    assert.match(get('manifest'),/build_version=00003/);
  }
});

test('original Roku base and embedded export template keep the same layout logic', async () => {
  for(const rel of ['components/screens/HomeScreen.brs','components/screens/HomeScreen.xml','components/MainScene.brs','components/Sidebar.brs','components/screens/CatalogScreen.brs','components/screens/CatalogScreen.xml']) {
    const [source,embedded]=await Promise.all([
      fs.readFile(path.join(ROOT,'roku',rel),'utf8'),
      fs.readFile(path.join(TEMPLATE,rel),'utf8')]);
    assert.equal(source,embedded,rel);
  }
});

test('simulator preview stays separate from real Roku playback and supports requested screens', async () => {
  const sim=await fs.readFile(path.join(ROOT,'parceiro/src/RokuSimulator.jsx'),'utf8');
  const studio=await fs.readFile(path.join(ROOT,'parceiro/src/AppearanceStudio.jsx'),'utf8');
  const admin=await fs.readFile(path.join(ROOT,'admin/src/pages/RokuBuildManager.jsx'),'utf8');
  for(const key of ['login','home','movies','series','live']) assert.match(sim,new RegExp("id: '"+key+"'"));
  for(const key of ['minimal','mosaic','library']) {
    assert.match(studio,new RegExp("id: '"+key+"'"));
    assert.match(admin,new RegExp('value="'+key+'"'));
  }
  assert.match(sim,/onKeyDown=\{keydown\}/);
  assert.match(sim,/remote\('ok'\)/);
  assert.match(sim,/Dados de demonstração/);
  assert.match(studio,/<RokuSimulator config=\{draft\}\/>/);
  assert.match(admin,/<RokuSimulator config=\{cfg\}\/>/);
});

test('icon rail remains controlled by the same navigation for minimal and mosaic', async () => {
  const sidebar=await fs.readFile(path.join(TEMPLATE,'components/Sidebar.brs'),'utf8');
  const scene=await fs.readFile(path.join(TEMPLATE,'components/MainScene.brs'),'utf8');
  const home=await fs.readFile(path.join(TEMPLATE,'components/screens/HomeScreen.brs'),'utf8');
  for (const theme of ['minimal','mosaic']) {
    assert.match(sidebar,new RegExp('config\\.template = "'+theme+'"'));
    assert.match(scene,new RegExp('visual\\.template = "'+theme+'"'));
  }
  assert.match(sidebar,/m\.labels\[i\]\.visible = not rail/);
  assert.match(home,/tile\.height = cardHeight/);
  assert.match(home,/m\.top\.findNode\("ring" \+ suffix\)/);
});
