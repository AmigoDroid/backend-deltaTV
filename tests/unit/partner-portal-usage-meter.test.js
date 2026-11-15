import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {instrumentPortalResponse,byteLen} from '../../src/modules/partner-portal-usage/meter-wire.js';
const id='aaaaaaa1-0000-4000-8000-000000000001';
const sid='bbbbbbb1-0000-4000-8000-000000000001';
function simulate({statusCode=200,header={}}={}){
 const res=new EventEmitter();res.statusCode=statusCode;
 res.getHeader=key=>header[key];res.write=function(x){this.sent.push(x);return true};
 res.end=function(x){if(x)this.sent.push(x);this.emit('finish');this.emit('close');return this};res.sent=[];
 const rows=[],sessions=[],liveSessions=new Map();
 instrumentPortalResponse(res,{partnerId:id,deviceId:id,sessionId:sid,kind:'live'},
 {add:r=>rows.push(r),touchSession:(...r)=>sessions.push(r),liveSessions,isUuid:v=>v===id||v===sid});
 return {res,rows,sessions,liveSessions};
}
test('a instrumentação contabiliza exatamente os bytes escritos e finalizados pelo Node',()=>{
 const {res,rows,liveSessions}=simulate();
 res.write(Buffer.alloc(7));res.write('á');res.end('fim');
 assert.equal(rows.filter(x=>x.bytes).reduce((s,x)=>s+x.bytes,0),7+2+3);
 assert.equal(rows.filter(x=>x.requests).length,1);
 assert.equal(rows.at(-1).transport,'node');assert.equal(liveSessions.size,0);
});
test('X-Accel-Redirect não pode ser apresentado como 0 GB medidos',()=>{
 const {res,rows}=simulate({header:{'X-Accel-Redirect':'/_origin/'}});
 res.end();assert.equal(rows.length,1);assert.equal(rows[0].transport,'nginx_unmetered');
 assert.equal(rows[0].requests,1);
});
test('302 de origem não conta bytes de mídia e não fatura proxy',()=>{
 const {res,rows}=simulate({statusCode:302});res.write('cabecalho');res.end('texto');
 assert.equal(rows.length,1);assert.equal(rows[0].transport,'redirect');
});
test('conexão abortada gera uma só amostra de requisição',()=>{
 const {res,rows,liveSessions}=simulate();res.write(Buffer.alloc(1024));res.emit('close');res.emit('finish');
 assert.equal(rows.filter(x=>x.requests).length,1);
 assert.equal(rows.reduce((sum,r)=>sum+(r.bytes||0),0),1024);
 assert.equal(liveSessions.size,0);
});
test('contagem de bytes usa encoding real em UTF-8',()=>{
 assert.equal(byteLen('á','utf8'),2);
 assert.equal(byteLen(Buffer.alloc(3)),3);
 assert.equal(byteLen(null),0);
});
