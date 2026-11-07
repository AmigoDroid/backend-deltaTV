import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCREEN_DEFAULTS,normalizeAppearanceScreens} from '../../src/modules/white-label/appearance.screens.js';
import {TEMPLATE,filesIn,individualize} from '../../src/modules/white-label/roku-builder.core.js';
import {defaultAppearance} from '../../src/modules/white-label/appearance.presets.js';
const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
test('preserva o texto antigo da Home ao evoluir o tema v1',()=>{
 const v=normalizeAppearanceScreens({heroTitle:'Cinema da Empresa',tagline:'Filmes sem complicações'});
 assert.equal(v.screens.home.heading,'Cinema da Empresa');
 assert.equal(v.screens.home.subtitle,'Filmes sem complicações');
 assert.equal(v.screens.movies.heading,SCREEN_DEFAULTS.movies.heading);
});
test('cópia de cada tela chega ao ZIP Roku Premium, inclusive offline',async()=>{
 const config=defaultAppearance('Exemplo Personalizado');
 config.screens.login.heading='Área de acesso';
 config.screens.movies.heading='Meu Cinema';
 config.screens.series.heading='Seriados da Casa';
 config.screens.home.featuredLabel='Escolhas do Dia';
 config.screens.home.showBanner=false;
 const result=individualize(await filesIn(TEMPLATE),{appKey:'app-exemplo',appName:'Exemplo Personalizado',appearance:config,edition:'dedicated',origin:'https://api.example.org'});
 const content=result.find(f=>f.path==='source/Config.brs').data.toString('utf8');
 for(const term of ['Área de acesso','Meu Cinema','Seriados da Casa','Escolhas do Dia','showBanner: false'])assert.ok(content.includes(term),term);
});
test('Roku base e template exportado usam as mesmas definições de telas',async()=>{
 for(const rel of ['source/Utils.brs','components/screens/ConnectScreen.brs','components/screens/ConnectScreen.xml','components/screens/HomeScreen.brs','components/screens/HomeScreen.xml','components/screens/CatalogScreen.brs','components/screens/CatalogScreen.xml','components/screens/LiveScreen.brs','components/screens/LiveScreen.xml','components/Sidebar.brs','components/MainScene.brs']){
  const [a,b]=await Promise.all([fs.readFile(path.join(base,'roku',rel)),fs.readFile(path.join(TEMPLATE,rel))]);
  assert.deepEqual(a,b,rel);
 }
});
