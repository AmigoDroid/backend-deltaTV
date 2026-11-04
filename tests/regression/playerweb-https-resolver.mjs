// Run: NODE_ENV=test node --experimental-test-module-mocks --test tests/regression/playerweb-https-resolver.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { PartnerCode, ProviderHealth } from '../../src/db/models/index.js';
const original={id:'original',baseUrl:'http://original.example',status:'active',priority:1};
const alternative={id:'alternative',baseUrl:'http://alternative.example',status:'active',priority:2};
let requests=[],pool=[original,alternative];
mock.module('../../src/modules/provider-monitor/code-pool.service.js',{namedExports:{serversForCode:async()=>pool}});
mock.module('../../src/modules/service-plans/plan.service.js',{namedExports:{getServicePlan:async()=>({features:{autoFailover:true,autoPriority:true}})}});
mock.module('../../src/modules/provider-monitor/visibility.service.js',{namedExports:{freshnessWindowSeconds:async()=>180}});
const ssrf=await import('../../src/shared/ssrf.js');
mock.module('../../src/shared/ssrf.js',{namedExports:{...ssrf,safeGet:async url=>{requests.push(url);const stream=Readable.from([Buffer.from(JSON.stringify({user_info:{auth:1,status:'Active'}}))]);stream.statusCode=200;return stream}}});
mock.method(PartnerCode,'findByPk',async()=>({id:'code',partnerId:'partner',status:'active'}));
mock.method(ProviderHealth,'findAll',async()=>pool.map(p=>({providerId:p.id,state:'healthy',latencyMs:p.id==='alternative'?10:100,lastCheckedAt:new Date()})));
const {resolveForActivation,clearResolutionCache}=await import('../../src/modules/provider-monitor/resolve.service.js');
const activation={id:'web',partnerCodeId:'code',partnerId:'partner',installationId:'webtv-AABBCCDDEEFF'};
process.env.PROVIDER_MONITOR_ENABLED='true';

test('smart selection verifies and returns the selected alternative using HTTPS without changing stored URLs',async()=>{
 clearResolutionCache();requests=[];pool=[original,alternative];
 const result=await resolveForActivation(activation,original,{username:'u',password:'p'});
 assert.equal(result.provider.id,'alternative');assert.equal(result.provider.baseUrl,'https://alternative.example/');
 assert.equal(result.verified,true);assert.ok(requests[0].startsWith('https://alternative.example/player_api.php?'));
 assert.equal(alternative.baseUrl,'http://alternative.example');assert.equal(original.baseUrl,'http://original.example');
});

test('disabled HTTPS selection uses the original HTTP schemes even for failover verification',async()=>{
 clearResolutionCache();requests=[];
 const result=await resolveForActivation({...activation,webAutoHttps:false},original,{username:'u',password:'p'});
 assert.equal(result.provider.baseUrl,'http://alternative.example');assert.ok(requests[0].startsWith('http://alternative.example/player_api.php?'));
});

test('web HTTPS conversion also applies when automatic failover is disabled',async()=>{
 process.env.PROVIDER_MONITOR_ENABLED='false';
 const result=await resolveForActivation(activation,original,{username:'u',password:'p'});
 assert.equal(result.provider.baseUrl,'https://original.example/');
 assert.equal(result.verified,false);
});
