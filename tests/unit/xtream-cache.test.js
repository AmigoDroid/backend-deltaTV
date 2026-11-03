import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
process.env.NODE_ENV='test';process.env.XTREAM_CACHE_MAX_MB='0';process.env.ALLOW_PRIVATE_SOURCES='true';
const {xtreamCall,clearXtreamCache}=await import('../../src/modules/xtream/xtream.client.js');
test('disabling Xtream cache does not retain the last response but coalesces parallel calls',async()=>{
 let calls=0;const server=http.createServer((_req,res)=>{calls++;res.setHeader('content-type','application/json');res.end('[{"name":"Teste"}]')}).listen(0,'127.0.0.1');await once(server,'listening');
 const account={base:`http://127.0.0.1:${server.address().port}`,username:'test',password:'test',key:'test-key'};
 try{clearXtreamCache();await xtreamCall(account,{}, {ttlSeconds:60});await xtreamCall(account,{}, {ttlSeconds:60});assert.equal(calls,2);await Promise.all([xtreamCall(account,{}, {ttlSeconds:60}),xtreamCall(account,{}, {ttlSeconds:60})]);assert.equal(calls,3);}
 finally{clearXtreamCache();await new Promise(r=>server.close(r));}
});
