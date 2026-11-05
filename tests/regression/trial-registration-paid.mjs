import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {sequelize,Device,DevicePairingToken,Activation,License,Plan,AuditLog} from '../../src/db/models/index.js';
const access=await import('../../src/modules/access/access.service.js');
let sessions=0,consumed=0,configured=false;
const mac='AA:BB:CC:DD:EE:11',installationId='roku-AABBCCDDEE11';
const act={id:'act',deviceId:'device',mac,installationId,licenseId:'trial',status:'active',createdAt:new Date('2026-01-01'),License:{isTrial:true,expiresAt:new Date('2030-01-01')},async update(patch){Object.assign(this,patch)}};
mock.module('../../src/modules/access/access.service.js',{namedExports:{...access,checkActivation:async()=>({activation:{...act,playlistUrlEnc:configured?'encrypted':null},decision:{allowed:true,expiresAt:act.License.expiresAt}}),enforceSessionCap:async()=>{},issueSession:async()=>{sessions++;return{accessToken:'access',refreshToken:'refresh'}}}});
const {pollRegistration}=await import('../../src/modules/devices/registration.service.js');
const {activateLicenseById}=await import('../../src/modules/activations/activation.service.js');
const device={id:'device',mac,lastInstallationId:installationId,async update(){}};
const pairing={id:'pair',Device:device,createdAt:new Date('2026-02-01'),expiresAt:new Date('2030-01-01'),async update(){consumed++}};
mock.method(DevicePairingToken,'findOne',async()=>pairing);mock.method(DevicePairingToken,'findByPk',async()=>pairing);
mock.method(Activation,'findAll',async()=>[act]);mock.method(Activation,'findOne',async()=>act);mock.method(Activation,'count',async()=>0);
mock.method(sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));mock.method(AuditLog,'create',async row=>row);mock.method(Device,'findByPk',async()=>device);
const paid={id:'paid',planId:'plan',status:'active',startsAt:new Date('2026-01-01'),expiresAt:new Date('2030-01-01'),maxDevices:1,async reload(){},async update(v){Object.assign(this,v)}};
const oldTrial={id:'trial',isTrial:true,status:'active',async update(v){Object.assign(this,v)}};
mock.method(License,'findByPk',async id=>id==='paid'?paid:oldTrial);mock.method(Plan,'findByPk',async()=>({id:'plan',active:true,durationMonths:12}));
test('unconfigured trial keeps pairing usable and does not issue a session prematurely',async()=>{
 const result=await pollRegistration({mac,installationId,registrationToken:'registration',meta:{}});
 assert.equal(result.configurationStatus,'awaiting_configuration');assert.equal(result.trial.active,true);assert.equal(consumed,0);assert.equal(sessions,0);
});
test('adding a list allows normal pairing completion and session issuance',async()=>{
 configured=true;const result=await pollRegistration({mac,installationId,registrationToken:'registration',meta:{}});
 assert.equal(result.configurationStatus,'configured_playlist');assert.equal(result.tokens.accessToken,'access');assert.equal(consumed,1);assert.equal(sessions,1);
});
test('paid activation replaces the trial license on the same activation and keeps its existing list',async()=>{
 act.playlistUrlEnc='original-list';const result=await activateLicenseById({licenseId:'paid',mac,installationId,meta:{}});
 assert.equal(result.activation.id,'act');assert.equal(act.licenseId,'paid');assert.equal(act.playlistUrlEnc,'original-list');assert.equal(oldTrial.status,'cancelled');
});
