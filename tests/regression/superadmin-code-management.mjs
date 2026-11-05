import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import router from '../../src/modules/partners/partner.routes.js';
import {sequelize,Partner,PartnerCode,PartnerProvider,CodeServerPool} from '../../src/db/models/index.js';
import {updateCode} from '../../src/modules/partners/partner.service.js';
const id='11111111-1111-4111-8111-111111111111',provider='22222222-2222-4222-8222-222222222222';
test('admin code validation preserves web authorization and expiration',()=>{
 const route=router.stack.find(x=>x.route?.path==='/:id/codes/:codeId'&&x.route.methods.patch).route;
 const req={params:{id,codeId:id},body:{allowWebIssuance:true,expiresAt:null}};
 route.stack[1].handle(req,{},()=>{});assert.deepEqual(req.valid.body,{allowWebIssuance:true,expiresAt:null});
});
test('code management actions reject non-superadmin roles',()=>{
 for(const path of ['/:id/codes/:codeId/management','/:id/codes/:codeId/servers','/:id/codes/:codeId/credits','/:id/codes/:codeId/restore']){
 const route=router.stack.find(x=>x.route?.path===path).route;
 for(const role of ['admin','support','partner'])assert.throws(()=>route.stack[0].handle({user:{role}},{},()=>{}),e=>e.status===403);
 let allowed=false;route.stack[0].handle({user:{role:'superadmin'}},{},()=>{allowed=true});assert.ok(allowed);
 }
});
test('saving an unchanged primary provider preserves failover associations',async()=>{
 const stop=new Error('stop before writes');let deletes=0;
 mock.method(sequelize,'transaction',async fn=>fn({LOCK:{UPDATE:'UPDATE'}}));
 mock.method(Partner,'findByPk',async()=>({id,kind:'content'}));
 mock.method(PartnerCode,'findOne',async()=>({id,providerId:provider,update:async()=>{throw stop}}));
 mock.method(PartnerProvider,'findOne',async()=>({id:provider,status:'active'}));
 mock.method(CodeServerPool,'destroy',async()=>{deletes++;return 2});
 try{await assert.rejects(updateCode(id,id,{providerId:provider,label:'Novo rótulo'},{role:'superadmin'}),e=>e===stop);assert.equal(deletes,0)}finally{mock.restoreAll()}
});
