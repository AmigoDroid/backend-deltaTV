import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
process.env.PROXY_ALL_DELIVERY = 'true';
process.env.NGINX_MEDIA_PROXY = 'true';
const { env } = await import('../../src/config/env.js');
const { relay } = await import('../../src/shared/relay.js');
const { deliveryModesOf, deliveryModeOf, describeDelivery } = await import('../../src/modules/mirror/mode.js');
import { rewritePlaylist, shouldInspectPlaylist } from '../../src/modules/sources/hls-rewrite.js';
import { m3uMirrorRewriter } from '../../src/modules/mirror/m3u-rewrite.js';
const { pinnedMediaTarget } = await import('../../src/shared/nginx-media.js');

async function listen(server, host) { server.listen(0,host); await once(server,'listening'); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(r=>server.close(r)); }
async function get(url, headers={}) {
 return new Promise((resolve,reject)=>http.get(url,{headers},res=>{const parts=[];res.on('data',c=>parts.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()}));}).on('error',reject));
}
test('global protection overrides redirects for TV, web and personal list',()=>{
  for(const activation of [{},{playlistUrlEnc:'x'},{deliveryMode:'redirect',deliveryModes:{api:'redirect'}},{Device:{platform:'web'}}]){
 assert.deepEqual(deliveryModesOf(activation),{api:'proxy',live:'proxy',movie:'proxy',series:'proxy'});
 assert.equal(deliveryModeOf(activation),'proxy');assert.equal(describeDelivery(activation).deliveryProtected,true);
 }
});
test('legacy modes remain available with protection disabled',()=>{
 execFileSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {deliveryModesOf} from './src/modules/mirror/mode.js';assert.equal(deliveryModesOf({deliveryMode:'redirect'}).api,'redirect');assert.equal(deliveryModesOf({deliveryMode:'proxy'}).movie,'proxy');`],{cwd:new URL('../../',import.meta.url),env:{...process.env,PROXY_ALL_DELIVERY:'false',NGINX_MEDIA_PROXY:'false'}});
});
test('all playlist MIME families are inspected, binary video is not buffered',()=>{
 for(const mime of ['audio/mpegurl','audio/x-mpegurl','video/vnd.apple.mpegurl','application/vnd.apple.mpegurl; charset=utf-8']) assert.equal(shouldInspectPlaylist(200,undefined,mime),true);
 assert.equal(shouldInspectPlaylist(200,undefined,'video/mp2t'),false);
 assert.equal(shouldInspectPlaylist(206,'bytes=0-','video/mp4'),false);
 assert.equal(shouldInspectPlaylist(200,'bytes=0-','video/mp2t','http://origin/a.m3u8'),true);
});
test('HLS keys, init segments, variants and media all stay on gateway',()=>{
 const calls=[];const out=rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="http://other/key"\n#EXT-X-MAP:URI="init.mp4"\nvariant.m3u8\n/seg.ts','http://origin/path/main.m3u8',url=>{calls.push(url);return '/hls/safe/'+calls.length});
 assert.equal(calls.length,4);assert.ok(!out.includes('http://'));assert.ok(out.includes('URI="/hls/safe/1"'));
});
test('opaque M3U media URLs are wrapped in full proxy mode',async()=>{
 const t=m3uMirrorRewriter({username:'u',password:'p',base:'https://delta',mirrorUser:'token',mirrorPass:'mirror',wrapOther:()=>'/hls/opaque'});
 const data=[];t.on('data',c=>data.push(c));t.end('#EXTM3U\nhttps://cdn/tokenized/video.mp4\n');await once(t,'end');assert.match(Buffer.concat(data).toString(),/\/hls\/opaque/);
});
test('IPv6 client receives IPv4 origin HLS through server-side redirect',async()=>{
 process.env.ALLOW_PRIVATE_SOURCES='true';
 const origin=http.createServer((req,res)=>{if(req.url==='/start'){res.writeHead(302,{location:'/list.m3u8'});res.end();return;}res.setHeader('content-type','audio/x-mpegurl');res.end('#EXTM3U\nhttp://127.0.0.1/segment.ts\n');});
 const port=await listen(origin,'127.0.0.1');
 const gateway=http.createServer((req,res)=>relay(req,res,`http://127.0.0.1:${port}/start`,{hlsWrap:()=>'/hls/signed'}).catch(e=>{res.statusCode=500;res.end(e.message)}));
 try{const gp=await listen(gateway,'::1');const result=await get(`http://[::1]:${gp}/`);assert.equal(result.status,200);assert.match(result.body,/\/hls\/signed/);assert.ok(!result.body.includes('127.0.0.1'));assert.equal(result.headers.location,undefined);}finally{await close(gateway);await close(origin);}
});
test('Nginx internal fallback follows origin redirect and preserves VOD Range',async()=>{
 process.env.ALLOW_PRIVATE_SOURCES='true';
 const origin=http.createServer((req,res)=>{if(req.url==='/start'){res.writeHead(307,{location:'/movie.mp4'});res.end();return;}assert.equal(req.headers.range,'bytes=2-4');res.writeHead(206,{'content-type':'video/mp4','content-range':'bytes 2-4/6','accept-ranges':'bytes'});res.end('cde');});
 const port=await listen(origin,'127.0.0.1');
 const gateway=http.createServer((req,res)=>relay(req,res,`http://127.0.0.1:${port}/start`,{media:true}).catch(e=>{res.statusCode=500;res.end(e.message)}));
 try{const gp=await listen(gateway,'::1');const result=await get(`http://[::1]:${gp}/`,{range:'bytes=2-4','x-delta-media-fallback':'deltatv-node-v1'});assert.equal(result.status,206);assert.equal(result.body,'cde');assert.equal(result.headers['content-range'],'bytes 2-4/6');assert.equal(result.headers.location,undefined);}finally{await close(gateway);await close(origin);process.env.ALLOW_PRIVATE_SOURCES='false';}
});
test('pinned Nginx target retains origin Host/SNI and rejects private IP',()=>{
 const result=pinnedMediaTarget('https://origin.example/movie.mp4','8.8.8.8');assert.equal(result.host,'origin.example');assert.equal(result.tlsName,'origin.example');assert.equal(result.target,'https://8.8.8.8/movie.mp4');assert.throws(()=>pinnedMediaTarget('http://origin.example/a','127.0.0.1'));
});

test('partial HLS is fetched without Range before rewriting',async()=>{
 process.env.ALLOW_PRIVATE_SOURCES='true';const ranges=[];
 const origin=http.createServer((req,res)=>{ranges.push(req.headers.range);res.writeHead(req.headers.range?206:200,{'content-type':'audio/mpegurl'});res.end('#EXTM3U\nhttp://origin/seg.ts\n');});
 const port=await listen(origin,'127.0.0.1');
 const gateway=http.createServer((req,res)=>relay(req,res,`http://127.0.0.1:${port}/playlist`,{hlsWrap:()=>'/hls/safe'}).catch(e=>{res.statusCode=500;res.end(e.message)}));
 try{const gp=await listen(gateway,'::1');const result=await get(`http://[::1]:${gp}/`,{range:'bytes=0-'});assert.equal(result.status,200);assert.match(result.body,/\/hls\/safe/);assert.deepEqual(ranges,['bytes=0-',undefined]);}finally{await close(gateway);await close(origin);process.env.ALLOW_PRIVATE_SOURCES='false';}
});
