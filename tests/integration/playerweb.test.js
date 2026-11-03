// Verifica transporte HTTP com mídia sintética; não verifica codecs no navegador.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {startNginxGateway} from './nginx-test-harness.js';
import {setupDatabase} from './db-harness.js';
process.env.NODE_ENV='test';process.env.ALLOW_PRIVATE_SOURCES='true';process.env.RATE_LIMIT_DISABLED='true';process.env.ENABLE_SCHEDULER='false';process.env.LOGIN_HISTORY_ISP_LOOKUP='false';process.env.PROVIDER_MONITOR_ENABLED='false';process.env.ACCEL_ORIGIN=process.env.DELTA_TEST_ACCEL==='1'?'1':'0';process.env.NGINX_MEDIA_PROXY=process.env.NGINX_TEST_BINARY?'true':'false';
const originHeader='https://player-test.example.invalid';process.env.CORS_ORIGINS=originHeader;
const require=createRequire(import.meta.url);
const payload=Buffer.from('0123456789abcdefghijklmnopqrstuv');
const origin=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(process.env.NGINX_TEST_BINARY){
  if(url.pathname==='/live/test-user/test-pass/2.m3u8'){
   res.setHeader('content-type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="/audio/list.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="/subs/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="audio",SUBTITLES="subs"\n/variants/list.m3u8\n');
  }
  const lists={'/variants/list.m3u8':'#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/assets/key.bin"\n#EXT-X-MAP:URI="/assets/init.mp4"\n#EXTINF:6,\n/assets/segment.m4s\n#EXT-X-ENDLIST\n','/audio/list.m3u8':'#EXTM3U\n#EXTINF:6,\n/assets/audio.aac\n#EXT-X-ENDLIST\n','/subs/list.m3u8':'#EXTM3U\n#EXTINF:6,\n/assets/subs.vtt\n#EXT-X-ENDLIST\n'};
  if(lists[url.pathname]){res.setHeader('content-type','application/vnd.apple.mpegurl');return res.end(lists[url.pathname]);}
  if(url.pathname.startsWith('/assets/')){
   const key=url.pathname.endsWith('.bin');res.setHeader('content-type',key?'application/octet-stream':url.pathname.endsWith('.vtt')?'text/vtt':'video/mp4');
   res.setHeader('access-control-allow-origin','*');res.setHeader('set-cookie','upstream-secret=do-not-forward');
   return res.end(key?Buffer.alloc(16,7):'asset-data');
  }
  if(url.pathname==='/movie/test-user/test-pass/2.mp4'){res.writeHead(302,{location:'/movie/test-user/test-pass/1.mp4'});return res.end();}
  if(url.pathname==='/movie/test-user/test-pass/3.mp4'){
   if(req.method==='HEAD'){res.setHeader('content-type','video/mp4');return res.end();}
   res.writeHead(302,{location:'http://127.0.0.1:'+origin.address().port+'/movie/test-user/test-pass/1.mp4'});return res.end();
  }
  if(url.pathname==='/movie/test-user/test-pass/4.mp4' && req.method==='HEAD'){res.statusCode=405;return res.end();}
  if(url.pathname==='/movie/test-user/test-pass/4.mp4'){res.setHeader('content-type','video/mp4');return res.end(payload);}
 }

 if(url.pathname==='/player_api.php'){
  res.setHeader('content-type','application/json');
  return res.end(JSON.stringify(url.searchParams.has('action')?[{stream_id:1,name:'Canal teste'}]:{user_info:{auth:1,status:'Active',username:'test-user',password:'test-pass'},server_info:{url:'origin.example.invalid',port:'80',server_protocol:'http'}}));
 }
 if(url.pathname==='/live/test-user/test-pass/1.m3u8'){
  res.setHeader('content-type','application/vnd.apple.mpegurl');res.write('#EXT');
  return setTimeout(()=>res.end('M3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/segments/one.ts\n#EXT-X-ENDLIST\n'),25);
 }
 if(url.pathname==='/segments/one.ts'){res.setHeader('content-type','video/mp2t');return res.end(Buffer.from([0x47,1,2,3,4,5]));}
 if(/^\/(movie|series)\/test-user\/test-pass\/1\.mp4$/.test(url.pathname)){
  res.setHeader('content-type','video/mp4');res.setHeader('accept-ranges','bytes');
  if(req.headers.range==='bytes=4-9'){res.writeHead(206,{'content-range':`bytes 4-9/${payload.length}`,'content-length':6});return res.end(payload.subarray(4,10));}
  res.setHeader('content-length',payload.length);return res.end(payload);
 }
 res.statusCode=404;res.end('not found');
}).listen(0,'127.0.0.1');await once(origin,'listening');
const apiServer=http.createServer().listen(0,'127.0.0.1');await once(apiServer,'listening');
const gatewayNginx=await startNginxGateway(apiServer.address().port);
const fetch=gatewayNginx?.fetch || globalThis.fetch;
const base=gatewayNginx?.base || `http://127.0.0.1:${apiServer.address().port}`;process.env.PUBLIC_BASE_URL=base;
const originBase=`http://127.0.0.1:${origin.address().port}`;
const {sequelize,Sequelize,close}=await setupDatabase();
const {createApp}=await import('../../src/app.js');apiServer.on('request',createApp());
const {Device,Partner,PartnerProvider,Activation,WebAccess}=await import('../../src/db/models/index.js');
const {hashCode,encryptSecret,verifyJwt}=await import('../../src/shared/crypto.js');
const {dropMirrorAuth}=await import('../../src/modules/mirror/mirror.cache.js');
const {playTokenFor}=await import('../../src/modules/access/access.service.js');
const {env}=await import('../../src/config/env.js');
let checks=0;function ok(label,fn){fn();checks++;console.log('PASS',label)}
async function json(path,opts={}){const res=await fetch(base+path,{...opts,headers:{origin:originHeader,'content-type':'application/json',...opts.headers}});return {status:res.status,data:await res.json()};}
try{
 for(const name of fs.readdirSync(new URL('../../src/db/migrations',import.meta.url)).sort())await require('../../src/db/migrations/'+name).up(sequelize.getQueryInterface(),Sequelize);
 const partner=await Partner.create({name:'Origem web de teste',slug:'web-playback-test',kind:'content',status:'active',startsAt:new Date(Date.now()-86400000),endsAt:new Date(Date.now()+864000000),billingModel:'none'});
 const provider=await PartnerProvider.create({partnerId:partner.id,name:'Origem simulada',baseUrl:originBase,playlistTemplate:'/get.php?username={username}&password={password}',status:'active',deliveryMode:'proxy'});
 const mac='02:57:45:00:00:11',installationId='webtv-025745000011';
 const device=await Device.create({mac,platform:'web',appId:'delta-tv-web',identifierType:'virtual_mac',lastInstallationId:installationId});
 const modes={api:'proxy',live:'proxy',movie:'proxy',series:'proxy'};
 const activation=await Activation.create({deviceId:device.id,mac,installationId,partnerId:partner.id,providerId:provider.id,credentialsEnc:encryptSecret(JSON.stringify({username:'test-user',password:'test-pass'})),status:'active',deliveryModes:modes});
 await WebAccess.create({deviceId:device.id,partnerId:partner.id,codeHash:hashCode('WEBAB123456'),codeEnc:encryptSecret('AB123456'),status:'active'});
 const login=await json('/api/v1/client/web/login',{method:'POST',body:JSON.stringify({code:'AB123456'})});ok('web login with access code',()=>{assert.equal(login.status,200,JSON.stringify(login.data));assert.equal(login.data.installationId,installationId)});
 const config=await json('/api/v1/client/xtream',{headers:{authorization:`Bearer ${login.data.tokens.accessToken}`}});ok('authorized Xtream config returns mirror',()=>{assert.equal(config.status,200,JSON.stringify(config.data));assert.equal(config.data.baseUrl,base);assert.equal(config.data.mirror,true)});
 const mirror=config.data.username;
 const auth=await json(`/player_api.php?username=${mirror}&password=mirror`);ok('mirror auth rewrites server and credentials',()=>{assert.equal(auth.status,200);assert.equal(auth.data.user_info.auth,1);assert.equal(auth.data.user_info.username,mirror);assert.equal(auth.data.server_info.url,'127.0.0.1')});
 const catalog=await json(`/player_api.php?username=${mirror}&password=mirror&action=get_live_streams`);ok('catalog through proxy',()=>{assert.equal(catalog.status,200);assert.equal(catalog.data[0].stream_id,1)});
 const playlist=await fetch(`${base}/live/${mirror}/mirror/1.m3u8`,{headers:{origin:originHeader}});const text=await playlist.text();
 ok('fragmented HLS header still rewrites segment URLs',()=>{assert.equal(playlist.status,200);assert.ok(text.startsWith('#EXTM3U'));assert.ok(text.includes('/hls/'));assert.ok(!text.includes('/segments/one.ts'))});
 const segment=text.split('\n').find(line=>line.startsWith('/hls/'));
 const stream=await fetch(base+segment,{headers:{origin:originHeader}});const segmentBody=Buffer.from(await stream.arrayBuffer());ok('rewritten HLS segment is authenticated and delivered',()=>{assert.equal(stream.status,200);assert.equal(segmentBody[0],0x47);assert.equal(stream.headers.get('access-control-allow-origin'),originHeader)});
 for(const kind of ['movie','series']){
  const video=await fetch(`${base}/${kind}/${mirror}/mirror/1.mp4`,{headers:{origin:originHeader,range:'bytes=4-9'}});const body=Buffer.from(await video.arrayBuffer());
  ok(`${kind} proxy preserves Range and HTTP 206`,()=>{assert.equal(video.status,206);assert.equal(video.headers.get('content-range'),`bytes 4-9/${payload.length}`);assert.deepEqual(body,payload.subarray(4,10));assert.ok(video.headers.get('access-control-expose-headers').includes('Content-Range'))});
 }
 const preflight=await fetch(`${base}/movie/${mirror}/mirror/1.mp4`,{method:'OPTIONS',headers:{origin:originHeader,'access-control-request-method':'GET','access-control-request-headers':'range'}});ok('browser preflight explicitly allows Range',()=>{assert.equal(preflight.status,204);assert.ok(preflight.headers.get('access-control-allow-headers').toLowerCase().split(',').includes('range'))});
 const claims=verifyJwt(login.data.tokens.accessToken,'device');const play=playTokenFor(activation.id,claims.sid);
 const gateway=await fetch(`${base}/api/v1/play/me/xl1.m3u8?t=${play}`,{headers:{origin:originHeader}});const gatewayText=await gateway.text();ok('catalog playback gateway handles fragmented HLS too',()=>{assert.equal(gateway.status,200,gatewayText);assert.ok(gatewayText.includes('/api/v1/play/me/_hls/'))});
 const gatewaySegment=gatewayText.split('\n').find(line=>line.startsWith('/api/v1/play/'));
 const gatewayMedia=await fetch(base+gatewaySegment);ok('catalog gateway segment downloads',()=>assert.equal(gatewayMedia.status,200));await gatewayMedia.arrayBuffer();

 if(gatewayNginx){
  function privateHeadersAbsent(response){for(const name of ['x-delta-origin-target','x-delta-origin-host','x-delta-origin-tls-name','x-delta-origin-ua','x-origin-url','x-accel-redirect','location','set-cookie'])assert.equal(response.headers.get(name),null,name);}
  const direct=await fetch(base+'/_deltatv_media');ok('internal media location cannot bypass authorization',()=>assert.equal(direct.status,404));
  const unauthorized=await fetch(base+'/movie/invalid-token/mirror/1.mp4');ok('unauthorized media is refused before offload',()=>assert.equal(unauthorized.status,401));
  const master=await fetch(`${base}/live/${mirror}/mirror/2.m3u8`);const masterText=await master.text();
  ok('master playlist keeps all variants, audio and subtitle URIs on API',()=>{assert.equal(master.status,200);assert.ok(!masterText.includes('http://'));assert.ok(masterText.includes('URI="/hls/'));assert.equal(master.headers.get('x-delta-media-transport'),'node-playlist');privateHeadersAbsent(master)});
  const links=body=>[...body.matchAll(/URI="([^"\n]+)"/g)].map(match=>match[1]).concat(body.split('\n').filter(line=>line.startsWith('/hls/')));
  let binaries=0;
  for(const link of links(masterText)){
   const child=await fetch(base+link);const childText=await child.text();assert.equal(child.status,200);assert.ok(childText.startsWith('#EXTM3U'));assert.ok(!childText.includes('http://'));
   for(const assetLink of links(childText)){
    const asset=await fetch(base+assetLink,{headers:{origin:originHeader}});const bytes=await asset.arrayBuffer();assert.equal(asset.status,200);assert.ok(bytes.length>0);assert.equal(asset.headers.get('x-delta-media-transport'),'nginx');assert.equal(asset.headers.get('access-control-allow-origin'),originHeader);privateHeadersAbsent(asset);binaries++;
   }
  }
  ok('keys, initialization, media, audio and subtitle assets are delivered by Nginx',()=>assert.equal(binaries,5));
  const resolved=await fetch(`${base}/movie/${mirror}/mirror/2.mp4`);ok('upstream HTTP redirect is resolved behind HTTPS without leaking Location',()=>{assert.equal(resolved.status,200);assert.equal(resolved.headers.get('x-delta-media-transport'),'nginx');privateHeadersAbsent(resolved)});
  const changed=await fetch(`${base}/movie/${mirror}/mirror/3.mp4`);ok('changed redirect after preflight fails closed instead of exposing HTTP',()=>{assert.equal(changed.status,502);assert.equal(changed.headers.get('location'),null)});
  const noHead=await fetch(`${base}/movie/${mirror}/mirror/4.mp4`);ok('origin without HEAD support still delivers through Nginx',()=>{assert.equal(noHead.status,200);assert.equal(noHead.headers.get('x-delta-media-transport'),'nginx')});
  const head=await fetch(`${base}/movie/${mirror}/mirror/1.mp4`,{method:'HEAD',headers:{range:'bytes=4-9'}});ok('HEAD and Range stay supported by Nginx',()=>{assert.equal(head.status,206);assert.equal(head.headers.get('content-range'),`bytes 4-9/${payload.length}`)});
  await activation.update({deliveryModes:{api:'redirect',live:'redirect',movie:'redirect',series:'redirect'}});dropMirrorAuth(activation.id);
  const managed=await json('/api/v1/client/xtream',{headers:{authorization:`Bearer ${login.data.tokens.accessToken}`}});ok('old web access with redirect remains on HTTPS mirror',()=>{assert.equal(managed.data.baseUrl,base);assert.deepEqual(managed.data.modes,{api:'proxy',live:'proxy',movie:'proxy',series:'proxy'})});
  const {relayStats}=await import('../../src/shared/relay.js');ok('completed media does not remain in Node stream counter',()=>assert.equal(relayStats().activeStreams,0));
 }
 await activation.update({deliveryModes:{...modes,movie:'redirect'}});dropMirrorAuth(activation.id);
 const redirect=await fetch(`${base}/movie/${mirror}/mirror/1.mp4`,{redirect:'manual'});
 ok(env.nginxMediaProxy?'movie stays on HTTPS through real Nginx':env.accelOrigin?'movie redirect delegates via X-Accel':'movie redirect preserves external 302',()=>{if(env.nginxMediaProxy){assert.equal(redirect.status,200);assert.equal(redirect.headers.get('x-delta-media-transport'),'nginx');assert.equal(redirect.headers.get('location'),null)}else if(env.accelOrigin){assert.equal(redirect.status,200);assert.equal(redirect.headers.get('x-accel-redirect'),'/_origin/');assert.equal(redirect.headers.get('x-origin-url'),originBase+'/movie/test-user/test-pass/1.mp4')}else{assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),originBase+'/movie/test-user/test-pass/1.mp4')}});await redirect.arrayBuffer();
}catch(error){console.error(error);process.exitCode=1}
finally{if(gatewayNginx)await gatewayNginx.close();await new Promise(r=>apiServer.close(r));await new Promise(r=>origin.close(r));await close()}
console.log('PLAYERWEB HTTP CHECKS',checks,'ACCEL',env.accelOrigin);
