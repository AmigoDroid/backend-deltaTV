// Testes isolados das rotas/controladores sem PostgreSQL real ou pacotes externos.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(){ super(); this.readyState=1; this.bufferedAmount=0; this.sent=[]; }
  send(data){ this.sent.push(JSON.parse(data)); }
  close(code=1000){ this.code=code; this.readyState=3; this.emit('close'); }
  terminate(){ this.close(1006); }
  ping(){ this.emit('pong'); }
}
class FakeWSS extends EventEmitter {
  handleUpgrade(_req,_socket,_head,callback){ const ws=new FakeWebSocket(); callback(ws); this.latest=ws; }
  close(){}
}

const filename = path.resolve(__dirname, '../../src/realtime/device-channel.js');
const source = fs.readFileSync(filename, 'utf8')
  .replace(/^import .*;\s*$/gm, '')
  .replace(/^export /gm, '') + '\nglobalThis.testApi = { currentSequence, currentDeviceChannelStats, broadcastDeviceHint, authorizeDevice, legacyPoll, createDeviceWebSocketServer, observeSocketEvent };';
const touches = [];
let revoked = false;
const ctx = vm.createContext({
  setTimeout, clearTimeout, setInterval, clearInterval, console, Date, JSON, Number, String, Math,
  process: { env: {} },
  WebSocket: FakeWebSocket, WebSocketServer: FakeWSS,
  Op: { in: 'in', gt: 'gt' }, env: { corsOrigins: [] },
  verifyJwt: () => ({ sid: 'session-1', aid: 'activation-1', exp: Math.floor(Date.now()/1000)+3600 }),
  DeviceSession: { findByPk: async () => ({ id:'session-1', activationId:'activation-1', expiresAt:new Date(Date.now()+600000), revokedAt:revoked?new Date():null }) },
  Activation: { findByPk: async () => ({ id:'activation-1', deviceId:'device-1' }) },
  touchDevice: id => touches.push(id),
  telemetrySchema: { safeParse: v => ({ success: !!v?.state && !!v.playback_id, data:v }) },
  observe: () => true,
  ipFamily: () => 4,
});
vm.runInContext(source, ctx, { filename });
const api=ctx.testApi;
class Response extends EventEmitter {
  status(n) { this.statusCode=n; return this; }
  set() { return this; }
  json(v) { this.body=v; this.writableEnded=true; return this; }
}
const request = () => ({ get:()=>'Bearer test', query:{ since:'0' } });

test('HTTPS legacy: 3k TVs aguardam um aviso e recebem apenas invalidacao', async () => {
  const n=3000, responses=Array.from({ length:n },()=>new Response());
  await Promise.all(responses.map((r)=>api.legacyPoll(request(),r)));
  assert.equal(api.currentDeviceChannelStats().waitingPolls,n);
  api.broadcastDeviceHint({topic:'devices'});
  assert.equal(api.currentDeviceChannelStats().waitingPolls,0);
  assert.equal(responses.filter(r=>r.body?.hints?.length===1).length,n);
  assert.equal(responses.filter(r=>r.body?.hints?.[0]?.type==='check-status').length,n);
  assert.equal(touches.length,n);
});

test('HTTPS legacy: sessoes revogadas respondem 401, sem fila aberta', async()=>{
  revoked=true;
  const res=new Response(); await api.legacyPoll(request(),res);
  assert.equal(res.statusCode,401);
  assert.equal(api.currentDeviceChannelStats().waitingPolls,0);
  revoked=false;
});

test('HTTPS legacy: desconexao do cliente limpa a fila e os timeouts',async()=>{
  const res=new Response(); const req=request(); req.query.since=String(api.currentSequence());
  await api.legacyPoll(req,res);
  assert.equal(api.currentDeviceChannelStats().waitingPolls,1);
  res.emit('close');
  assert.equal(api.currentDeviceChannelStats().waitingPolls,0);
});

test('cliente envia somente estados validos de telemetria',()=>{
  const peer={ activationId:'activation-1',sessionId:'session-1' };
  assert.equal(api.observeSocketEvent(peer,{payload:{state:'error',playback_id:'id'}},'127.0.0.1'),true);
  assert.equal(api.observeSocketEvent(peer,{payload:{state:'invalid'}},'127.0.0.1'),false);
});


test('WSS: autentica o device, aceita telemetria e encerra ao parar', async()=>{
  const service=api.createDeviceWebSocketServer();
  const req={url:'/ws/device',headers:{},socket:{remoteAddress:'127.0.0.1'}};
  let client=null;
  // API real: faz upgrade com callback; no mock a instância fica no WebSocketServer.
  // Acessar o último socket por um handler exposto no fake.
  const original=FakeWSS.prototype.handleUpgrade;
  FakeWSS.prototype.handleUpgrade=function(req,socket,head,callback){
    client=new FakeWebSocket(); callback(client); this.latest=client;
  };
  try {
    service.handleUpgrade(req,{destroy(){},write(){}},Buffer.alloc(0));
    client.emit('message',Buffer.from(JSON.stringify({type:'auth',token:'fake'})),false);
    // Duas consultas mockadas assíncronas.
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(client.sent[0].type,'ready');
    assert.equal(api.currentDeviceChannelStats().websocket,1);
    client.emit('message',Buffer.from(JSON.stringify({type:'heartbeat'})),false);
    assert.equal(client.sent.at(-1).type,'heartbeat-ack');
    client.emit('message',Buffer.from(JSON.stringify({type:'telemetry',payload:{state:'playing',playback_id:'abc'}})),false);
    client.close();
    assert.equal(api.currentDeviceChannelStats().websocket,0);
  } finally {
    FakeWSS.prototype.handleUpgrade=original;
    service.stop();
  }
});
