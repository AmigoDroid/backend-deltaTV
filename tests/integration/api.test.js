import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {setupDatabase} from './db-harness.js';
process.env.NODE_ENV='test';process.env.ENABLE_SCHEDULER='false';process.env.RATE_LIMIT_DISABLED='true';process.env.LOGIN_HISTORY_ISP_LOOKUP='false';
const require=createRequire(import.meta.url);
const {db,sequelize,Sequelize,close}=await setupDatabase();
for(const name of fs.readdirSync(new URL('../../src/db/migrations',import.meta.url)).sort())await require('../../src/db/migrations/'+name).up(sequelize.getQueryInterface(),Sequelize);
const models=await import('../../src/db/models/index.js');
const {hashPassword,signJwt,hmacHex}=await import('../../src/shared/crypto.js');
const {env}=await import('../../src/config/env.js');
const {createApp}=await import('../../src/app.js');
const {Partner,AdminUser,Invoice,Activation,Device,PartnerCode,PartnerProvider}=models;
const hash=await hashPassword('Testing-Delta-2026!');
const superuser=await AdminUser.create({name:'Teste admin',email:'test-admin@example.invalid',passwordHash:hash,role:'superadmin'});
const partners=[];const users=[];
for(let i=0;i<2;i++){
 const p=await Partner.create({name:'Parceiro '+i,slug:'teste-'+i,kind:'content',startsAt:new Date(Date.now()-86400000),endsAt:new Date(Date.now()+8640000000),billingModel:'fixed',monthlyFeeCents:10000});partners.push(p);
 const u=await AdminUser.create({name:'Teste parceiro '+i,email:`p${i}@example.invalid`,passwordHash:hash,role:'partner',partnerId:p.id});users.push(u);
}
const server=createApp().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
const token=u=>signJwt({typ:'admin',sub:u.id,tv:u.tokenVersion},3600);
async function call(path,{user=superuser,method='GET',body,headers={}}={}){const res=await fetch(base+path,{method,headers:{'content-type':'application/json',...(user?{authorization:'Bearer '+token(user)}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json().catch(()=>null);return {status:res.status,data};}
let checks=0;function ok(label,fn){fn();checks++;console.log('PASS',label);}
try{
 const health=await call('/health',{user:null});ok('health',()=>assert.equal(health.status,200));
 const adminDenied=await call('/api/v1/admin/partners',{user:users[0]});ok('partner cannot read admin',()=>assert.equal(adminDenied.status,403));
 const created=await call('/api/v1/content-partner/clients',{user:users[0],method:'POST',body:{mac:'AA:BB:CC:DD:EE:01',name:'Cliente teste',priceCents:2990,dueDate:'2026-11-30'}});ok('create partner customer',()=>assert.equal(created.status,201,JSON.stringify(created.data)));
 const foreign=await call('/api/v1/content-partner/clients/'+created.data.id,{user:users[1],method:'PATCH',body:{name:'Intruso'}});ok('customer tenant isolation',()=>assert.equal(foreign.status,404));
 const invalid=await call('/api/v1/content-partner/clients/'+created.data.id,{user:users[0],method:'PATCH',body:{dueDate:'2026-99-99'}});ok('invalid calendar date is 422, not 500',()=>assert.equal(invalid.status,422));
 const adminReads=['/admin/partners','/admin/partners/contract-overview','/admin/partners/pre-registrations','/admin/devices','/admin/devices/unlinked','/admin/devices/registrations','/admin/licenses','/admin/service-plans','/admin/users','/admin/clients','/admin/clients/summary','/admin/billing/invoices','/admin/billing/payments','/admin/sources','/admin/audit','/admin/dashboard','/admin/notifications/campaigns','/admin/pix/charges','/admin/credits/rates','/admin/web-access','/admin/app-downloads'];
 for(const path of adminReads){const r=await call('/api/v1'+path);ok('superadmin GET '+path,()=>assert.equal(r.status,200,JSON.stringify(r.data)));}
 const partnerReads=['/account','/clients','/clients/summary','/licenses','/invoices','/payments','/credit-ledger','/downloads','/web-access','/notifications','/commercial','/overview','/service-plan','/codes'];
 for(const path of partnerReads){const r=await call('/api/v1/content-partner'+path,{user:users[0]});ok('partner GET '+path,()=>assert.equal(r.status,200,JSON.stringify(r.data)));}
 const device=await Device.create({mac:'AA:BB:CC:DD:EE:02',platform:'roku',installationId:'integration-test'});
 const activation=await Activation.create({deviceId:device.id,mac:device.mac,partnerId:partners[0].id,status:'active'});
 const block=await call(`/api/v1/content-partner/devices/${activation.id}/block`,{user:users[0],method:'POST',body:{reason:'Teste de bloqueio'}});ok('partner blocks owned activation',()=>assert.equal(block.status,200,JSON.stringify(block.data)));
 const denied=await call(`/api/v1/content-partner/devices/${activation.id}/unblock`,{user:users[1],method:'POST',body:{}});ok('activation tenant isolation',()=>assert.equal(denied.status,404));
 const unblock=await call(`/api/v1/content-partner/devices/${activation.id}/unblock`,{user:users[0],method:'POST',body:{}});ok('partner unblocks owned activation',()=>assert.equal(unblock.status,200,JSON.stringify(unblock.data)));
 const revoke=await call(`/api/v1/content-partner/devices/${activation.id}/revoke`,{user:users[0],method:'POST',body:{reason:'Fim do teste de vínculo'}});ok('partner revokes with reason',()=>assert.equal(revoke.status,204,JSON.stringify(revoke.data)));
 const provider=await PartnerProvider.create({partnerId:partners[0].id,name:'Provedor teste',baseUrl:'https://example.invalid',playlistTemplate:'/get.php?username={username}&password={password}',status:'disabled',priority:77,deliveryMode:'proxy'});
 const rename=await call(`/api/v1/admin/partners/${partners[0].id}/providers/${provider.id}`,{method:'PATCH',body:{name:'Nome corrigido'}});ok('partial provider update succeeds',()=>assert.equal(rename.status,200,JSON.stringify(rename.data)));
 await provider.reload();ok('partial update preserves provider priority',()=>assert.equal(provider.priority,77));ok('partial update preserves disabled provider',()=>assert.equal(provider.status,'disabled'));ok('partial update preserves delivery mode',()=>assert.equal(provider.deliveryMode,'proxy'));
 const invoice=await Invoice.create({partnerId:partners[0].id,competence:'2026-11',deviceCount:0,amountCents:10000,dueDate:'2026-11-10',breakdown:{}});
 const event={eventId:'delta-test-event',type:'payment.confirmed',invoiceId:invoice.id,amountCents:4000,providerRef:'test-reference'};
 async function webhook(){const ts=String(Date.now());return call('/api/v1/webhooks/payments/generic',{user:null,method:'POST',body:event,headers:{'x-webhook-timestamp':ts,'x-webhook-signature':hmacHex(env.webhookSecret,ts+'.'+JSON.stringify(event))}});}
 const savedCreate=models.Payment.create;let failOnce=true;models.Payment.create=async function(...args){if(failOnce){failOnce=false;throw new Error('Simulated temporary write failure');}return savedCreate.apply(this,args)};
 const failure=await webhook();models.Payment.create=savedCreate;ok('webhook transient error rolls back',()=>assert.equal(failure.status,500));
 const retry=await webhook();ok('webhook retry delivers payment',()=>assert.equal(retry.data?.ok,true,JSON.stringify(retry)));
 const dup=await webhook();ok('webhook duplicate is idempotent',()=>assert.equal(dup.data?.duplicate,true));
 await invoice.reload();ok('invoice has exactly one payment',()=>assert.equal(invoice.paidCents,4000));const paymentCount=await models.Payment.count();ok('only one payment row',()=>assert.equal(paymentCount,1));
}catch(e){console.error(e);process.exitCode=1;}finally{await new Promise(r=>server.close(r));await close();}
console.log('INTEGRATION CHECKS',checks);
