// Run: NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/playerweb-https.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import Sequelize from 'sequelize';
import { withHttps, usesWebHttps, webBaseUrl, webProvider, webHlsTarget } from '../../src/modules/web/web-https.js';
import migration from '../../src/db/migrations/20261123000001-playerweb-auto-https.cjs';
import { PartnerProvider, PlatformSetting } from '../../src/db/models/index.js';
import { encryptSecret } from '../../src/shared/crypto.js';
import { xtreamCredentialsOf } from '../../src/modules/xtream/xtream.service.js';
import { playlistUrlForActivation } from '../../src/modules/sources/sources.service.js';
import { playerApi, mediaStream, xmltv } from '../../src/modules/mirror/mirror.handlers.js';

const defaults = { trial: { enabled: true, days: 30 }, web: { autoHttps: true, deliveryModes: {} } };
mock.method(PlatformSetting, 'findByPk', async () => ({ value: defaults }));
const { clearSettingsCache } = await import('../../src/modules/settings/platform-settings.service.js');
const provider = { id: 'provider-1', status: 'active', baseUrl: 'http://provider.example:8080', playlistTemplate: '/get.php?username={username}&password={password}', toJSON() { const {toJSON,...values}=this;return values; } };
const web = { id:'activation-1',providerId:provider.id,partnerId:'partner-1',installationId:'webtv-AABBCCDDEEFF',credentialsEnc:encryptSecret(JSON.stringify({username:'user',password:'pass'})) };
mock.method(PartnerProvider,'findByPk',async()=>provider);

test('HTTP becomes HTTPS, HTTPS remains identical, and custom ports/paths/queries are preserved',()=>{
  assert.equal(withHttps('http://provider.example'), 'https://provider.example/');
  assert.equal(withHttps('http://provider.example:80'), 'https://provider.example/');
  assert.equal(withHttps('http://provider.example:8080/path?a=1'), 'https://provider.example:8080/path?a=1');
  assert.equal(withHttps('https://provider.example:8443/path?a=1'), 'https://provider.example:8443/path?a=1');
  assert.equal(withHttps('http://provider.example',false), 'http://provider.example');
});

test('HTTPS defaults to enabled only for web partnership activations; TVs and own playlists remain unchanged',()=>{
  assert.equal(usesWebHttps(web),true);
  assert.equal(usesWebHttps({...web,installationId:'roku-installation'}),false);
  assert.equal(usesWebHttps({...web,installationId:null,Device:{platform:'web'}}),true);
  assert.equal(webBaseUrl(provider.baseUrl,{...web,webAutoHttps:false}),provider.baseUrl);
  assert.equal(webBaseUrl(provider.baseUrl,{...web,playlistUrlEnc:'own-playlist'}),provider.baseUrl);
  const selected=webProvider(provider,web);
  assert.equal(selected.baseUrl,'https://provider.example:8080/');
  assert.equal(provider.baseUrl,'http://provider.example:8080');
});

test('Xtream configuration and M3U source both use HTTPS, and disabling restores the original URL',async()=>{
  const credentials=await xtreamCredentialsOf(web);
  assert.equal(credentials.baseUrl,'https://provider.example:8080');
  assert.equal(credentials.webAutoHttps,true);
  assert.equal((await xtreamCredentialsOf({...web,webAutoHttps:false})).baseUrl,'https://provider.example:8080');
  assert.ok((await playlistUrlForActivation(web)).startsWith('https://provider.example:8080/get.php?'));
  defaults.web.autoHttps=false; clearSettingsCache();
  assert.equal((await xtreamCredentialsOf({...web,webAutoHttps:true})).baseUrl,'http://provider.example:8080');
  defaults.web.autoHttps=true; clearSettingsCache();
  assert.equal((await xtreamCredentialsOf({...web,installationId:'roku-installation'})).baseUrl,'http://provider.example:8080');
});

test('API, EPG and movie redirects use the selected HTTPS base while preserving delivery choices',async()=>{
  const credentials=await xtreamCredentialsOf(web);
  const ctx={cred:credentials,modes:{api:'redirect',movie:'redirect'}};
  const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value},end(){}});
  const api=response();await playerApi(ctx,{},api,{action:'get_live_categories'});
  assert.ok(api.headers.Location.startsWith('https://provider.example:8080/player_api.php?'));
  const epg=response();await xmltv(ctx,{},epg);
  assert.ok(epg.headers.Location.startsWith('https://provider.example:8080/xmltv.php?'));
  const movie=response();await mediaStream(ctx,{},movie,'movie','42.mp4');
  assert.equal(movie.headers.Location,'https://provider.example:8080/movie/user/pass/42.mp4');
});

test('absolute HLS links on the partner host are upgraded while external CDN links remain unchanged',()=>{
  const cred={baseUrl:'https://provider.example:8080',webAutoHttps:true};
  assert.equal(webHlsTarget('http://provider.example:8080/segment.ts',cred),'https://provider.example:8080/segment.ts');
  assert.equal(webHlsTarget('http://cdn.example/segment.ts',cred),'http://cdn.example/segment.ts');
  assert.equal(webHlsTarget('http://provider.example:8080/segment.ts',{...cred,webAutoHttps:false}),'http://provider.example:8080/segment.ts');
});

test('migration enables the default for existing and new activations, persists disabled state, and reverses',async()=>{
  const db=new PGlite();
  try{
    await db.exec("CREATE TABLE activations(id text PRIMARY KEY); INSERT INTO activations VALUES ('existing');");
    const qi={addColumn:()=>db.exec('ALTER TABLE activations ADD COLUMN web_auto_https boolean NOT NULL DEFAULT true'),removeColumn:()=>db.exec('ALTER TABLE activations DROP COLUMN web_auto_https')};
    await migration.up(qi,Sequelize);
    assert.equal((await db.query("SELECT web_auto_https FROM activations WHERE id='existing'")).rows[0].web_auto_https,true);
    await db.exec("INSERT INTO activations(id) VALUES ('new'); UPDATE activations SET web_auto_https=false WHERE id='existing'");
    assert.equal((await db.query("SELECT web_auto_https FROM activations WHERE id='existing'")).rows[0].web_auto_https,false);
    assert.equal((await db.query("SELECT web_auto_https FROM activations WHERE id='new'")).rows[0].web_auto_https,true);
    await migration.down(qi);
    assert.equal((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='activations' AND column_name='web_auto_https'")).rows.length,0);
  }finally{await db.close()}
});
