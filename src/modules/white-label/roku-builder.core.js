// Exports one isolated white-label Roku sideload ZIP per app (not an encrypted/signed .pkg).
// All source files come from the trusted embedded SceneGraph template; no client-supplied paths.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from './roku-zip.js';
import { pngImage } from './roku-render.js';

export const TEMPLATE = fileURLToPath(new URL('./roku-template/', import.meta.url));
export const ROKU_EDITIONS = Object.freeze(['economy', 'dedicated']);
const MAX_FILE_COUNT = 700;
const skip = new Set([
  'images/splash.jpg', 'images/splash_fhd.jpg', 'images/logo.png', 'images/icon_focus_hd.png',
  'images/icon_focus_sd.png', 'images/banner-delta.jpg', 'images/connect_bg.jpg',
]);

export async function filesIn(dir, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const target = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesIn(target, rel));
    else if (entry.isFile() && !skip.has(rel) && (/^(source|components|images)\//.test(rel) || rel === 'manifest'))
      result.push({ path: rel, data: await fs.readFile(target) });
  }
  return result;
}
function replaceOnly(text, oldText, newText, filename) {
  if (!text.includes(oldText)) throw new Error(`Modelo Roku incompatível (${filename}).`);
  return text.replace(oldText, newText);
}
function xmlEscape(s) { return String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function brs(s) { return `"${String(s).replaceAll('"','""').replace(/[\r\n]/g,' ')}"`; }
function manifestUpdate(source, name, mainColor, buildVersion) {
  const map = {
    title: name.slice(0, 30), major_version: '1', minor_version: '0', build_version: String(buildVersion).padStart(5, '0'),
    mm_icon_focus_hd: 'pkg:/images/brand_icon_hd.png',
    mm_icon_focus_sd: 'pkg:/images/brand_icon_sd.png',
    splash_screen_hd: 'pkg:/images/brand_splash_hd.png',
    splash_screen_fhd: 'pkg:/images/brand_splash_fhd.png',
    splash_color: mainColor,
  };
  const attrs = Object.fromEntries(source.split(/\r?\n/).filter(l=>l && !l.startsWith('#')).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1)]));
  Object.assign(attrs,map);
  attrs.sg_component_libs_required='roku_analytics';
  const out = Object.entries(attrs).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
  if (!out.endsWith('\n')) throw new Error('Manifest inválido.');
  return out;
}

export function individualize(files, { appKey, appName, appearance, edition, origin, buildVersion = 1, assets = {} }) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(appKey)) throw Error('Identificador do aplicativo inválido.');
  if (!ROKU_EDITIONS.includes(edition)) throw Error('Modalidade de aplicativo inválida.');
  if (!Number.isInteger(buildVersion) || buildVersion < 1 || buildVersion > 99999) throw Error('Número da build Roku inválido (1 a 99999).');
  const config = appearance;
  const safeName = String(appName || appearance?.brandName || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 45);
  if (safeName.length < 2) throw Error('Nome do canal inválido para o manifest Roku.');
  const own = edition === 'dedicated';
  const bg = config.backgroundColor || '#090B14';
  const accent = config.primaryColor || '#6B47E6';
  const label = own ? safeName.slice(0,8) : 'TV';
  const normalized = files.map(f => ({...f}));
  const file = rel => {
    const x=normalized.find(f=>f.path===rel);
    if(!x) throw Error(`Modelo Roku incompleto: ${rel}`);
    return x;
  };
  const configFile = file('source/Config.brs');
  let src = configFile.data.toString('utf8');
  src=replaceOnly(src,'function DeltaWhiteLabelAppKey() as String\n    return ""',
    `function DeltaWhiteLabelAppKey() as String\n    return ${brs(appKey)}`,'Config.brs');
  src=replaceOnly(src,'function DeltaWhiteLabelApiOrigin() as String\n    return "https://api.deltatv.com.br"',
    `function DeltaWhiteLabelApiOrigin() as String\n    return ${brs(origin)}`,'Config.brs');
  src=replaceOnly(src,'function DeltaServerOrigin() as String\n    \' Use um host acessível pelo Roku; localhost aponta para o proprio aparelho.\n    return "https://delta-tv.duckdns.org"',
    `function DeltaServerOrigin() as String\n    return ${brs(origin)}`,'Config.brs');
  const pairs = Object.entries(config).filter(([k,v])=>typeof v==='string' && /^[a-zA-Z]+$/.test(k)).map(([k,v])=>`${k}: ${brs(v)}`).join(', ');
  src=replaceOnly(src, "return invalid ' Replaced at packaging with a published snapshot.", `return {${pairs}}`, 'Config.brs');
  configFile.data=Buffer.from(src);
  const manifest = file('manifest');
  manifest.data=Buffer.from(manifestUpdate(manifest.data.toString('utf8'), safeName, bg, buildVersion));
  const renames = [
    ['components/screens/HomeScreen.xml', 'pkg:/images/banner-delta.jpg', 'pkg:/images/brand_banner.png'],
    ['components/screens/ConnectScreen.xml', 'pkg:/images/connect_bg.jpg', 'pkg:/images/brand_connect.png'],
    ['components/screens/HomeScreen.brs', 'banner-delta.jpg', 'brand_banner.png'],
  ];
  for(const [rel, search, replace] of renames) {
    const f=file(rel);f.data=Buffer.from(replaceOnly(f.data.toString(),search,replace,rel));
  }
  const home=file('components/screens/HomeScreen.brs');
  home.data=Buffer.from(replaceOnly(home.data.toString(),
    'if config <> invalid then m.wlHero = WLImageUri(config.heroUrl)',
    'if config <> invalid then m.wlHero = WLImageUri(config.heroUrl)\n    if DeltaWhiteLabelMode() and m.wlHero = "" then m.wlHero = "pkg:/images/brand_banner.png"',
    home.path));
  const substitutions = [
    ['components/screens/HomeScreen.xml', 'Bem-vindo ao Delta TV', `Bem-vindo ao ${xmlEscape(safeName.slice(0,30))}`],
    ['components/screens/SettingsScreen.xml', 'MAC VIRTUAL DO DELTA TV', 'IDENTIFICADOR DO DISPOSITIVO'],
    ['components/screens/SettingsScreen.xml', 'text="Delta TV"', `text="${xmlEscape(safeName.slice(0,30))}"`],
    ['components/screens/SettingsScreen.xml', 'O Delta TV é apenas um reprodutor.', `${xmlEscape(safeName.slice(0,30))} é apenas um reprodutor.`],
    ['components/screens/ConnectScreen.xml', 'text="DELTA"', `text="${xmlEscape(safeName.slice(0,30))}"`],
    ['components/screens/ConnectScreen.xml', 'text="TV"', 'text=""'],
    ['components/screens/ConnectScreen.xml', 'Sua experiência Delta TV', 'Seu acesso ao entretenimento'],
    ['components/screens/ConnectScreen.xml', 'Delta TV • Entretenimento do seu jeito', `${xmlEscape(safeName.slice(0,30))} • Reproduza conteúdo autorizado`],
    ['components/Sidebar.xml', 'text="DELTA"', `text="${xmlEscape(safeName.slice(0,30))}"`],
    ['components/Sidebar.xml', 'text="TV"', 'text=""'],
    ['components/Sidebar.xml', 'Delta TV  •  Não vendemos conteúdo', `${xmlEscape(safeName.slice(0,30))}  •  Sem conteúdo incluso`],
  ];
  for(const [rel,search,replacement] of substitutions) {
    const f=file(rel); f.data=Buffer.from(replaceOnly(f.data.toString(),search,replacement,rel));
  }
  const art = [
    ['images/logo.png',180,180,label],
    ['images/brand_icon_hd.png',336,210,label],
    ['images/brand_icon_sd.png',246,140,label],
    ['images/brand_splash_hd.png',1280,720,label],
    ['images/brand_splash_fhd.png',1920,1080,label],
    ['images/brand_banner.png',1020,314,label],
    ['images/brand_connect.png',1280,720,label],
  ];
  normalized.push(...art.map(([p,w,h,t])=>({path:p,data:assets[p] || pngImage(w,h,bg,accent,t)})));
  if(normalized.length>MAX_FILE_COUNT) throw Error('Modelo possui arquivos demais.');
  return normalized;
}

