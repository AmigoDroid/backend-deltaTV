import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {attachRealtime,livePartnerIds} from '../../src/realtime/socket.js';
import {AdminUser} from '../../src/db/models/index.js';
import {signJwt} from '../../src/shared/crypto.js';
import {env} from '../../src/config/env.js';
test('concurrent socket auth cannot create orphan peers',async()=>{
 const original=AdminUser.findByPk;let resolve;const gate=new Promise(r=>resolve=r);let checks=0;
 const user={id:'00000000-0000-4000-8000-000000000001',role:'partner',partnerId:'00000000-0000-4000-8000-000000000002',status:'active',tokenVersion:0};
 AdminUser.findByPk=async()=>{checks++;return gate};
 const server=http.createServer().listen(0,'127.0.0.1');await once(server,'listening');const stop=attachRealtime(server);
 const socket=new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`,{origin:env.corsOrigins[0]});
 try{await once(socket,'open');const packet=JSON.stringify({type:'auth',token:signJwt({typ:'admin',sub:user.id,tv:0},60)});const closed=once(socket,'close');socket.send(packet);socket.send(packet);const [code]=await closed;resolve(user);await new Promise(r=>setImmediate(r));assert.equal(code,1008);assert.equal(checks,1);assert.deepEqual(livePartnerIds(),[]);}
 finally{resolve(user);AdminUser.findByPk=original;socket.terminate();stop();await new Promise(r=>server.close(r));}
});
