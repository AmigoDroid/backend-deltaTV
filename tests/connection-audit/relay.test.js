import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
process.env.ALLOW_PRIVATE_SOURCES='true';process.env.NGINX_MEDIA_PROXY='false';
const {relay}=await import('../../src/shared/relay.js');
const listen=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;};
const close=server=>new Promise(r=>{server.closeAllConnections();server.close(r);});
test('proxy reports redirected origin, status and connection family without claiming playback',async()=>{
 const upstream=http.createServer((req,res)=>{
  if(req.url==='/start'){res.writeHead(302,{location:'/file'});res.end();return;}
  if(req.url==='/error'){res.writeHead(503);res.end('unavailable');return;}
  res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 0-2/6'});res.end('abc');
 });
 const port=await listen(upstream);const events=[];
 const gateway=http.createServer((req,res)=>relay(req,res,`http://127.0.0.1:${port}${req.url}`,{media:true,onConnection:e=>events.push(e)}).catch(e=>{res.statusCode=e.status||502;res.end();}));
 const gp=await listen(gateway);
 try{
  const response=await fetch(`http://127.0.0.1:${gp}/start`);assert.equal(await response.text(),'abc');
  assert.equal(events[0].state,'response');assert.equal(events[0].statusCode,206);assert.equal(events[0].origin,`http://127.0.0.1:${port}/file`);assert.equal(events[0].upstreamFamily,4);assert.ok(events[0].latencyMs>=0);
  await (await fetch(`http://127.0.0.1:${gp}/error`)).text();assert.ok(events.some(e=>e.state==='error'&&e.statusCode===503));assert.ok(!events.some(e=>e.state==='playing'));
 }finally{await close(gateway);await close(upstream);}
});
