import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { parseDueDate } from '../../src/modules/clients/client.rules.js';
import { signJwt, verifyJwt } from '../../src/shared/crypto.js';
import { safeGet, isPrivateAddress } from '../../src/shared/ssrf.js';
import { sequelize } from '../../src/db/sequelize.js';
import { flushPresence, touchDevice, _resetPresence, _dirtySize } from '../../src/modules/devices/presence.js';
import { createCustomer } from '../../src/modules/services/panelCustomerCreateService.js';
import { normalizeLoginResponse } from '../../src/modules/services/panelAuthService.js';
import { featuresFor } from '../../src/modules/service-plans/plan.rules.js';
import { can } from '../../src/middleware/authenticate.js';

test('invalid calendar dates return validation errors without throwing',()=>{
 for(const date of ['2026-99-99','2026-02-30','2026-00-01','bad']) assert.ok(parseDueDate(date).error,date);
 assert.equal(parseDueDate('2024-02-29').value,'2024-02-29');
});
test('JWT exp boundary and claim types',()=>{
 const now=Math.floor(Date.now()/1000);
 assert.throws(()=>verifyJwt(signJwt({typ:'admin'},0,{iat:now}),'admin'),{code:'INVALID_TOKEN'});
 assert.throws(()=>verifyJwt(signJwt({typ:'admin'},'invalid',{iat:now}),'admin'),{code:'INVALID_TOKEN'});
 assert.equal(verifyJwt(signJwt({typ:'admin'},60),'admin').typ,'admin');
 assert.throws(()=>verifyJwt(signJwt({typ:'device'},60),'admin'),{code:'INVALID_TOKEN'});
});
test('empty presence flush does not permanently stop future updates',async()=>{
 _resetPresence();const query=sequelize.query;let calls=0;
 sequelize.query=async()=>{calls++;return [[],{}]};
 try {await flushPresence();touchDevice('00000000-0000-4000-8000-000000000001');assert.equal(await flushPresence(),1);assert.equal(calls,1);assert.equal(_dirtySize(),0);}
 finally {sequelize.query=query;_resetPresence();}
});
test('failed presence flush retries the pending batch',async()=>{
 _resetPresence();const query=sequelize.query;let calls=0;
 sequelize.query=async()=>{if(++calls===1)throw Error('test outage');return [[],{}]};
 try {touchDevice('00000000-0000-4000-8000-000000000001');assert.equal(await flushPresence(),0);assert.equal(_dirtySize(),1);assert.equal(await flushPresence(),1);assert.equal(calls,2);}
 finally {sequelize.query=query;_resetPresence();}
});
test('upstream customer creation sends cookies and token; does not follow redirects',async()=>{
 const old=globalThis.fetch;let options;
 globalThis.fetch=async(_url,opts)=>{options=opts;return {ok:true,headers:{getSetCookie:()=>[]},text:async()=>'{"id":1}'}};
 try {await createCustomer({cookies:'session=example',token:'test-token',customer:{name:'Teste',username:'test',password:'test',server_id:1,package_id:1}});
 assert.equal(options.headers.Cookie,'session=example');assert.equal(options.headers.Authorization,'Bearer test-token');assert.equal(options.redirect,'error');assert.equal(JSON.parse(options.body).username,'test');}
 finally{globalThis.fetch=old;}
});
test('panel auth module is importable and normalizes the response',()=>{
 assert.equal(normalizeLoginResponse({user:{id:1,username:'test'},token:'test-token'}).token,'test-token');
});
test('superadmin permissions remain unrestricted',()=>{
 for(const perm of ['users:manage','system:metrics','devices:edit','override','billing:write'])assert.equal(can('superadmin',perm),true);
 assert.equal(can('partner','devices:edit'),false);assert.equal(can('support','users:manage'),false);
});
test('plan overrides retain unlimited URLs and failover dependencies',()=>{
 assert.equal(featuresFor('partner_professional',{maxServersOverride:0}).maxServers,null);
 assert.equal(featuresFor('partner_premium',{autoFailoverOverride:false}).autoPriority,false);
});
test('SSRF blocks private IPv4 and IPv6 destinations',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1'])assert.equal(isPrivateAddress(ip),true,ip);
 assert.equal(isPrivateAddress('8.8.8.8'),false);
});
test('invalid upstream redirect rejects without crashing the server',async()=>{
 const previous=process.env.ALLOW_PRIVATE_SOURCES;process.env.ALLOW_PRIVATE_SOURCES='true';
 const server=http.createServer((_req,res)=>{res.writeHead(302,{location:'http://['});res.end()}).listen(0,'127.0.0.1');await once(server,'listening');
 try{await assert.rejects(safeGet(`http://127.0.0.1:${server.address().port}`),{code:'INVALID_REDIRECT'});}
 finally{await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.ALLOW_PRIVATE_SOURCES;else process.env.ALLOW_PRIVATE_SOURCES=previous;}
});
test('cross-origin redirects do not forward authorization or cookies',async()=>{
 const previous=process.env.ALLOW_PRIVATE_SOURCES;process.env.ALLOW_PRIVATE_SOURCES='true';let headers;
 const target=http.createServer((req,res)=>{headers=req.headers;res.end('OK')}).listen(0,'127.0.0.1');await once(target,'listening');
 const origin=http.createServer((_req,res)=>{res.writeHead(302,{location:`http://127.0.0.1:${target.address().port}`});res.end()}).listen(0,'127.0.0.1');await once(origin,'listening');
 try{const response=await safeGet(`http://127.0.0.1:${origin.address().port}`,{headers:{Authorization:'secret',Cookie:'session=secret'}});response.resume();assert.equal(headers.authorization,undefined);assert.equal(headers.cookie,undefined);}
 finally{await new Promise(r=>origin.close(r));await new Promise(r=>target.close(r));if(previous===undefined)delete process.env.ALLOW_PRIVATE_SOURCES;else process.env.ALLOW_PRIVATE_SOURCES=previous;}
});

test('PATCH validation leaves creation defaults absent',async()=>{
 const {z}=await import('zod');const {partialInput}=await import('../../src/shared/validate.js');
 const schema=z.object({name:z.string(),priority:z.number().default(0),status:z.string().default('active')});
 assert.deepEqual(partialInput(schema).parse({name:'Changed'}),{name:'Changed'});
 assert.deepEqual(partialInput(schema).parse({priority:0}),{priority:0});
});
