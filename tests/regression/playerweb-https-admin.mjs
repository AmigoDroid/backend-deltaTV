// Run: NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/playerweb-https-admin.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { WebAccess, Activation, AuditLog, PartnerCode, Partner, PlatformSetting, sequelize } from '../../src/db/models/index.js';
import { encryptSecret } from '../../src/shared/crypto.js';
import { errorHandler } from '../../src/shared/errors.js';
import { cachedMirrorAuth, mirrorAuthCacheSize, clearMirrorAuth } from '../../src/modules/mirror/mirror.cache.js';
const access = await import('../../src/modules/access/access.service.js');
mock.module('../../src/modules/access/access.service.js',{namedExports:{...access,checkActivation:async()=>({decision:{allowed:true}}),overdueSinceFor:async()=>null}});
const providers = await import('../../src/modules/providers/provider.service.js');
const probed=[];
mock.module('../../src/modules/providers/provider.service.js',{namedExports:{...providers,probeCredentials:async provider=>{probed.push(provider.baseUrl);return {ok:true}}}});
const pools=await import('../../src/modules/provider-monitor/code-pool.service.js');
const original={id:'p1',baseUrl:'http://provider.example',status:'active',partnerId:'owner'};
mock.module('../../src/modules/provider-monitor/code-pool.service.js',{namedExports:{...pools,serversForCode:async()=>[original]}});
const { preparePartnerActivation } = await import('../../src/modules/activations/activation.service.js');
const { updateWebAccess } = await import('../../src/modules/web/web-access.service.js');
const {savePlatformSection,clearSettingsCache} = await import('../../src/modules/settings/platform-settings.service.js');
const {default: settingsRouter} = await import('../../src/modules/settings/platform-settings.routes.js');
const defaults={trial:{enabled:true,days:30},web:{autoHttps:true,deliveryModes:{api:'redirect',live:'proxy',movie:'redirect',series:'redirect'}}};
mock.method(PlatformSetting,'findByPk',async()=>({value:defaults}));
mock.method(PlatformSetting,'upsert',async row=>{Object.assign(defaults,row.value)});
mock.method(sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));
const { adminRouter } = await import('../../src/modules/web/web.routes.js');
const id='11111111-1111-4111-8111-111111111111';
const activation={id:'activation-1',deviceId:'device-1',providerId:'p1',webAutoHttps:true,installationId:'webtv-AABBCCDDEEFF',toJSON(){return {...this}},async update(patch){Object.assign(this,patch)}};
const wa={id,deviceId:activation.deviceId,status:'active',codeEnc:encryptSecret('AB123456'),async update(patch){Object.assign(this,patch)}};
mock.method(WebAccess,'findOne',async()=>wa);
mock.method(Activation,'findOne',async()=>activation);
mock.method(AuditLog,'create',async values=>values);
mock.method(PartnerCode,'findOne',async()=>({id:'code-1',code:'123456',partnerId:'owner',status:'active',providerId:'p1'}));
mock.method(Partner,'findByPk',async()=>({id:'owner',status:'active',startsAt:new Date('2025-01-01'),endsAt:new Date('2030-01-01')}));

test('superadmin saves global HTTPS, invalidates mirror cache, and keeps trial settings',async()=>{
 clearMirrorAuth();
 await cachedMirrorAuth('cache-key',async()=>({activationId:activation.id,value:{old:true}}),60000);
 assert.equal(mirrorAuthCacheSize(),1);
 const result=await savePlatformSection('web',{...defaults.web,autoHttps:false},{type:'admin',id:'admin'});
 assert.equal(result.web.autoHttps,false);assert.equal(result.trial.days,30);
 assert.equal(mirrorAuthCacheSize(),0);
 await assert.rejects(updateWebAccess(id,{webAutoHttps:true},{actor:{type:'admin'}}),error=>error.code==='NOTHING_TO_CHANGE');
 await savePlatformSection('web',{...defaults.web,autoHttps:true},{type:'admin'});
});

test('web creation validates HTTPS without changing provider data; ordinary TV validation uses its original URL',async()=>{
 await preparePartnerActivation({code:'123456',username:'u',password:'p',web:true});
 assert.equal(probed.at(-1),'https://provider.example/');
 assert.equal(original.baseUrl,'http://provider.example');
 await preparePartnerActivation({code:'123456',username:'u',password:'p'});
 assert.equal(probed.at(-1),'http://provider.example');
});

test('general web configuration is superadmin-only and validates the complete default settings',async()=>{
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{req.user={id:'test',role:req.headers['x-test-role']||'superadmin'};next()});
 app.use('/settings',settingsRouter);app.use('/web',adminRouter);app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/settings/web`;
  const request=(role,value)=>fetch(url,{method:'PUT',headers:{'Content-Type':'application/json','x-test-role':role},body:JSON.stringify({...defaults.web,autoHttps:value})});
  const good=await request('superadmin',false);assert.equal(good.status,200);assert.equal((await good.json()).web.autoHttps,false);
  assert.equal((await request('superadmin','false')).status,400);
  for(const role of ['support','partner','admin'])assert.equal((await request(role,true)).status,403);
  assert.equal(defaults.web.autoHttps,false);
  const trialUrl=`http://127.0.0.1:${server.address().port}/settings/trial`;
  const putTrial=days=>fetch(trialUrl,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true,days})});
  assert.equal((await putTrial(0)).status,400);assert.equal((await putTrial(366)).status,400);
  const trialSaved=await putTrial(14);assert.equal(trialSaved.status,200);
  const combined=await trialSaved.json();assert.equal(combined.trial.days,14);assert.equal(combined.web.autoHttps,false);
 }finally{await new Promise(resolve=>server.close(resolve))}
});
