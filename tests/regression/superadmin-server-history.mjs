import {test,before,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import Utils from 'sequelize/lib/utils';
import {sequelize,PartnerProvider,ProviderHealthEvent} from '../../src/db/models/index.js';
import {getServerHistory} from '../../src/modules/provider-monitor/server-history.service.js';
import {adminServerMonitor} from '../../src/modules/provider-monitor/visibility.routes.js';
import {errorHandler} from '../../src/shared/errors.js';
const db=new PGlite(),gen=sequelize.getQueryInterface().queryGenerator;
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222',missing='33333333-3333-4333-8333-333333333333';
const providers=new Map([[first,{id:first,name:'Servidor Básico',partnerId:'partner-basic',baseUrl:'https://basic.example',Partner:{name:'Parceiro Básico'}}],[second,{id:second,name:'Servidor Premium',partnerId:'partner-premium',baseUrl:'https://premium.example',Partner:{name:'Parceiro Premium'}}]]);
mock.method(PartnerProvider,'findByPk',async id=>providers.get(id)||null);
mock.method(ProviderHealthEvent,'findAndCountAll',async options=>{
 const mapped=Utils.mapFinderOptions({...options,where:options.where},ProviderHealthEvent);
 const rows=await db.query(gen.selectQuery('provider_health_events',{...mapped},ProviderHealthEvent));
 const count=await db.query(gen.selectQuery('provider_health_events',{where:mapped.where,attributes:[[sequelize.fn('count',sequelize.col('id')),'total']]},ProviderHealthEvent));
 return{rows:rows.rows,count:Number(count.rows[0].total)};
});
before(async()=>{await db.exec(`CREATE TABLE provider_health_events(id text PRIMARY KEY,provider_id uuid,state text,latency_ms int,note text,occurred_at timestamptz);
 INSERT INTO provider_health_events SELECT 'event-'||n,'${first}',CASE WHEN n%2=0 THEN 'healthy' ELSE 'down' END,n*10,CASE WHEN n%2=0 THEN NULL ELSE 'Timeout' END,'2026-11-01'::timestamptz+n*interval '1 minute' FROM generate_series(1,40)n;
 INSERT INTO provider_health_events VALUES('premium-event','${second}','slow',3000,'Resposta lenta','2026-11-02');`)});
after(()=>db.close());
test('superadmin history contains state, latency and notes for servers of any partnership with no plan lookup',async()=>{
 const a=await getServerHistory(first);assert.equal(a.meta.total,40);assert.equal(a.provider.partnerName,'Parceiro Básico');assert.equal(a.data[0].latencyMs,400);
 const b=await getServerHistory(second);assert.equal(b.meta.total,1);assert.equal(b.data[0].note,'Resposta lenta');assert.equal(b.provider.partnerName,'Parceiro Premium');
});
test('history pagination and state filter execute in PostgreSQL and never mix providers',async()=>{
 const a=await getServerHistory(first,{page:1,pageSize:7,status:'down'}),b=await getServerHistory(first,{page:2,pageSize:7,status:'down'});
 assert.equal(a.meta.total,20);assert.equal(a.meta.totalPages,3);assert.equal(a.data.length,7);
 assert.equal(new Set([...a.data,...b.data].map(e=>e.id)).size,14);assert.ok([...a.data,...b.data].every(e=>e.state==='down'&&e.id!=='premium-event'));
 await assert.rejects(getServerHistory(missing),error=>error.status===404);
});
test('history endpoint permits only superadmin, validates UUID/paging and responds no-store',async()=>{
 const app=express();app.use((req,_res,next)=>{const role=req.headers['x-role'];if(role)req.user={role};next()});app.use('/monitor',adminServerMonitor);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const root=`http://127.0.0.1:${server.address().port}/monitor`;
  const get=(path,role='superadmin')=>fetch(root+path,{headers:{'x-role':role}});
  for(const id of[first,second]){const response=await get(`/${id}/history`);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).provider.id,id)}
  for(const role of['admin','partner','support'])assert.equal((await get(`/${first}/history`,role)).status,403);
  assert.equal((await fetch(root+`/${first}/history`)).status,403);
  assert.equal((await get('/invalid/history')).status,400);assert.equal((await get(`/${first}/history?page=0`)).status,400);
  assert.equal((await get(`/${missing}/history`)).status,404);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
