/** Integration HTTP + PostgreSQL DESCARTÁVEL. Não substitui testes de banco por regex. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

if(!process.env.DATABASE_URL_TEST){
 test('planos ocultos HTTP/PostgreSQL',{skip:'DATABASE_URL_TEST ausente: integração não executada'},()=>{});
}else{
 if(process.env.DELTA_FINANCE_DB_CONFIRM!=='DISPOSABLE')
  throw new Error('Recusado banco não confirmado como descartável.');
 process.env.DATABASE_URL=process.env.DATABASE_URL_TEST;
 process.env.RATE_LIMIT_DISABLED='true';
 const [{default:supertest},{createApp},db,{hashPassword}]=await Promise.all([
  import('supertest'),import('../../src/app.js'),import('../../src/db/models/index.js'),import('../../src/shared/crypto.js')
 ]);
 const http=supertest(createApp());
 const tag=randomUUID().replaceAll('-','').slice(0,10),password='Only-Test-Network-Plan-Long!';
 const perms=['network:plans:read','network:plans:write','network:partners:read','network:partners:write'];
 const admin=async(name)=>db.AdminUser.create({name,email:`plan-${name}-${tag}@example.test`,
  role:'admin',passwordHash:await hashPassword(password),delegatedPermissions:perms});
 const partner=async(name,ownerAdminId)=>db.Partner.create({name,slug:`plan-${name}-${tag}`,
  ownerAdminId,kind:'content',startsAt:new Date(Date.now()-86400000),
  endsAt:new Date(Date.now()+30*86400000),billingModel:'none',status:'active'});
 const plan=async(key,ownerAdminId,hiddenFromNetwork)=>db.ServicePlanCatalog.create({
  key,name:`Plano ${key}`,ownerAdminId,audience:'content',monthlyPriceCents:0,
  validityDays:10,active:true,hiddenFromNetwork,
 });
 const login=async(user,audience='admin')=>{
  const r=await http.post('/api/v1/auth/login').send({email:user.email,password,audience});
  assert.equal(r.status,200,JSON.stringify(r.body));return `Bearer ${r.body.accessToken}`;
 };
 test('Admin A não lista nem muda plano B; próprio plano oculto não aparece em convites; atribuição manual preserva contrato',async()=>{
  const [a,b]=await Promise.all([admin('A'),admin('B')]);
  const [pa,pb]=await Promise.all([partner('A',a.id),partner('B',b.id)]);
  const keyA=`n${tag}a`,keyB=`n${tag}b`;
  await Promise.all([plan(keyA,a.id,true),plan(keyB,b.id,true)]);
  const ta=await login(a);
  const list=await http.get('/api/v1/admin/workspace/plans').set('Authorization',ta);
  assert.equal(list.status,200,JSON.stringify(list.body));
  assert.ok(list.body.data.some(p=>p.key===keyA&&p.hiddenFromNetwork===true));
  assert.ok(!list.body.data.some(p=>p.key===keyB));
  const inviteOptions=await http.get('/api/v1/admin/workspace/invitations/plans').set('Authorization',ta);
  assert.equal(inviteOptions.status,200,JSON.stringify(inviteOptions.body));
  assert.ok(!inviteOptions.body.data.some(p=>p.key===keyA));
  const forbidden=await http.put(`/api/v1/admin/workspace/plans/${keyB}`).set('Authorization',ta).send({hiddenFromNetwork:false});
  assert.equal(forbidden.status,404);
  const other=await http.patch(`/api/v1/admin/workspace/partners/${pb.id}`).set('Authorization',ta).send({planKey:keyA});
  assert.equal(other.status,404);
  const granted=await http.patch(`/api/v1/admin/workspace/partners/${pa.id}`).set('Authorization',ta).send({planKey:keyA});
  assert.equal(granted.status,200,JSON.stringify(granted.body));
  const assigned=await db.PartnerServicePlan.findByPk(pa.id);
  assert.equal(assigned.tier,keyA);
  assert.equal((await db.Partner.findByPk(pa.id)).status,'active');
  const noPix=await http.post('/api/v1/admin/workspace/finance/charges/preview').set('Authorization',ta)
    .send({partnerId:pa.id,kind:'renewal',planTo:keyA});
  assert.equal(noPix.status,422);
 });
 test.after(async()=>{await db.sequelize.close()});
}
