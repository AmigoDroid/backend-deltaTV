import assert from 'node:assert/strict';
import test from 'node:test';
import { individualize, filesIn, TEMPLATE } from '../../src/modules/white-label/roku-builder.core.js';
import { buildZip } from '../../src/modules/white-label/roku-zip.js';
import { pngImage } from '../../src/modules/white-label/roku-render.js';
import { validateRokuPng } from '../../src/modules/white-label/roku-assets.js';
import { defaultAppearance } from '../../src/modules/white-label/appearance.presets.js';

test('ZIP format and Roku identity are generated without a signing key', async () => {
  const model=await filesIn(TEMPLATE);
  const appearance=defaultAppearance('Minha Marca TV');
  const files=individualize(model,{ appKey:'cliente-abc',appName:'Minha Marca TV',appearance,edition:'dedicated',origin:'https://api.deltatv.com.br' });
  const get = filename => files.find(f=>f.path===filename)?.data.toString('utf8');
  assert.match(get('manifest'),/^title=Minha Marca TV$/m);
  assert.match(get('manifest'),/^sg_component_libs_required=roku_analytics$/m);
  assert.match(get('source/Config.brs'),/return "cliente-abc"/);
  assert.match(get('source/Config.brs'),/https:\/\/api.deltatv.com.br/);
  assert.doesNotMatch(get('source/Config.brs'),/return "https:\/\/delta-tv.duckdns.org"/);
  assert(!files.some(f => f.path==='images/banner-delta.jpg'));
  assert(!files.some(f => f.path==='images/splash.jpg'));
  assert(files.some(f=>f.path==='images/brand_splash_hd.png'));
  assert(files.some(f=>f.path==='components/tasks/WhiteLabelAuthTask.brs'));
  assert(!files.some(f=>f.path.endsWith('.bak')||f.path.endsWith('.md')));
  const zip=buildZip(files);
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);
  assert(zip.length<15_000_000);
});
test('economy and dedicated editions do not share app keys and use different package icons',async()=>{
  const model=await filesIn(TEMPLATE),appearance=defaultAppearance('Teste');
  const dedicated=individualize(model,{appKey:'teste-a',appName:'Teste',appearance,edition:'dedicated',origin:'https://api.deltatv.com.br'});
  const economy=individualize(model,{appKey:'teste-b',appName:'Teste',appearance,edition:'economy',origin:'https://api.deltatv.com.br'});
  const img = rows=>rows.find(f=>f.path==='images/brand_icon_hd.png')?.data;
  assert.notDeepEqual(img(dedicated),img(economy));
});
test('ZIP rejects directory traversal and duplicate entries',()=>{
  assert.throws(()=>buildZip([{path:'../manifest',data:'test'}]),/inseguro/);
  assert.throws(()=>buildZip([{path:'manifest',data:'a'},{path:'manifest',data:'b'}]),/duplicado/);
});
test('PNG generator creates a valid PNG signature',()=>{
  const img=pngImage(320,180,'#090B14','#E7A94B','AB');
  assert.equal(img.readUInt32BE(16),320);assert.equal(img.readUInt32BE(20),180);
  assert.equal(img[0],137);assert.equal(img[1],80);
});

test('exports control independent Roku build versions',async()=>{
  const files=individualize(await filesIn(TEMPLATE),{appKey:'teste-versao',appName:'Minha TV',
    appearance:defaultAppearance('Minha TV'),edition:'dedicated',origin:'https://api.deltatv.com.br',buildVersion:42});
  assert.match(files.find(f=>f.path==='manifest').data.toString(),/^build_version=00042$/m);
  assert.throws(()=>individualize(files,{appKey:'teste-versao',appName:'Minha TV',
    appearance:defaultAppearance('Minha TV'),edition:'dedicated',origin:'https://api.deltatv.com.br',buildVersion:100000}),/inválido/);
});

test('uploaded channel images are fully decoded and reject corrupted PNG data',()=>{
  const good=pngImage(336,210,'#090B14','#6B47E6','TV');
  assert.deepEqual(validateRokuPng('icon_hd',good),{width:336,height:210,size:good.length});
  assert.throws(()=>validateRokuPng('splash_hd',good),/Tamanho inválido/);
  const corrupt=Buffer.from(good);corrupt[100]^=1;
  assert.throws(()=>validateRokuPng('icon_hd',corrupt),/CRC da imagem inválido/);
  assert.throws(()=>validateRokuPng('icon_hd',good.subarray(0,good.length-8)),/PNG incompleto/);
});

test('channel title is escaped against manifest injection',async()=>{
  const files=individualize(await filesIn(TEMPLATE),{appKey:'teste-seguro',
    appName:'Canal Exemplo\nmajor_version=999',appearance:defaultAppearance('Canal Exemplo'),
    edition:'dedicated',origin:'https://api.deltatv.com.br'});
  const manifest=files.find(f=>f.path==='manifest').data.toString();
  assert.match(manifest,/^title=Canal Exemplo major_version=99$/m);
  assert.equal((manifest.match(/^major_version=/gm)||[]).length,1);
});
