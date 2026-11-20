/** Teste HTTP real com PostgreSQL já migrado, isolado, descartável. Não é teste de texto.
 * DATABASE_URL_TEST=postgres://... DELTA_FINANCE_DB_CONFIRM=DISPOSABLE \
 * NODE_ENV=test node --test tests/integration/network-finance-supertest.test.js
 * Instale supertest como dependência de desenvolvimento no ambiente de teste.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL_TEST) {
  test('HTTP Supertest/Postgres finanças de rede', {skip:'Sem DATABASE_URL_TEST: nenhuma integração HTTP executada'},()=>{});
} else {
  if(process.env.DELTA_FINANCE_DB_CONFIRM!=='DISPOSABLE')
    throw new Error('Recusado banco não confirmado. Defina DELTA_FINANCE_DB_CONFIRM=DISPOSABLE somente para banco descartável.');
  process.env.DATABASE_URL=process.env.DATABASE_URL_TEST;
  process.env.RATE_LIMIT_DISABLED='true';
  const [{default:supertest},{createApp},db,{hashPassword,encryptSecret}]=await Promise.all([
    import('supertest'),import('../../src/app.js'),import('../../src/db/models/index.js'),import('../../src/shared/crypto.js'),
  ]);
  const http=supertest(createApp());
  const suffix=randomUUID().slice(0,8),password='Test-only-finance-2026-Strong!';
  const user=async (role,name,permissions=[])=>db.AdminUser.create({name,email:`finance-${name}-${suffix}@example.test`,role,
    passwordHash:await hashPassword(password),delegatedPermissions:permissions});
  const p=async (name,ownerAdminId)=>db.Partner.create({name,slug:`finance-${name.toLowerCase()}-${suffix}`,ownerAdminId,
    kind:'content',startsAt:new Date(Date.now()-86400000),endsAt:new Date(Date.now()+30*86400000),billingModel:'none'});
  const login=async u=>{
    const r=await http.post('/api/v1/auth/login').send({email:u.email,password,audience:'admin'});
    assert.equal(r.status,200,JSON.stringify(r.body));return `Bearer ${r.body.accessToken}`;
  };
  const seed=async(adminId,partnerId)=>{
    const [rows]=await db.sequelize.query(`INSERT INTO admin_network_charges(owner_admin_id,partner_id,kind,plan_to,amount_cents,status,method,expires_at)
      VALUES(:a,:p,'renewal','testing',1499,'pending','manual',now()+interval '1 day') RETURNING id`,
      {replacements:{a:adminId,p:partnerId}});return rows[0].id;
  };
  test('HTTP: Admin A não lê nem modifica cobranças B; rota global 403; Superadmin consulta e cancela com auditoria',async()=>{
    const perms=['network:billing:read','network:billing:write','network:gateways:read','network:gateways:write'];
    const [a,b,root]=await Promise.all([user('admin','A',perms),user('admin','B',perms),user('superadmin','Root')]);
    const [pa,pb]=await Promise.all([p('A',a.id),p('B',b.id)]);
    const [ca,cb]=await Promise.all([seed(a.id,pa.id),seed(b.id,pb.id)]);
    const [ta,tb,tr]=await Promise.all([login(a),login(b),login(root)]);
    // Teste HTTP real de troca de gateway sem chamada externa: credenciais já
    // testadas são preparadas no banco descartável, e a API ativa cada escolha.
    const fp='f'.repeat(64);
    for(const provider of ['mercadopago','infinitepay']){
      await db.sequelize.query(`INSERT INTO admin_network_gateways
        (admin_user_id,provider,credentials_enc,account_ref,credential_fingerprint,tested_fingerprint,tested_at)
        VALUES(:a,:provider,:secret,:ref,:fp,:fp,now())`,{replacements:{
          a:a.id,provider,secret:encryptSecret('only-for-disposable-integration-test'),
          ref:provider==='mercadopago'?'12345678':'teste-infinite',fp}});
    }
    const mpa=await http.post('/api/v1/admin/workspace/finance/gateways/mercadopago/activate').set('Authorization',ta);
    assert.equal(mpa.status,200,JSON.stringify(mpa.body));
    const newPartner=await p('OldProvider',a.id);
    const [legacy]=await db.sequelize.query(`INSERT INTO admin_network_charges
      (owner_admin_id,partner_id,kind,plan_to,amount_cents,status,method,provider,expires_at)
      VALUES(:a,:partner,'renewal','testing',2300,'pending','automatic','mercadopago',now()+interval '1 day')
      RETURNING id`,{replacements:{a:a.id,partner:newPartner.id}});
    const switched=await http.post('/api/v1/admin/workspace/finance/gateways/infinitepay/activate').set('Authorization',ta);
    assert.equal(switched.status,200,JSON.stringify(switched.body));
    const visible=await http.get('/api/v1/admin/workspace/finance/gateways').set('Authorization',ta);
    assert.equal(visible.status,200);
    assert.equal(visible.body.data.filter(x=>x.active).length,1);
    assert.equal(visible.body.data.find(x=>x.active).provider,'infinitepay');
    const [old]=await db.sequelize.query('SELECT provider,status FROM admin_network_charges WHERE id=:id',
      {replacements:{id:legacy[0].id}});
    assert.equal(old[0].provider,'mercadopago');
    assert.equal(old[0].status,'pending');
    assert.ok(!JSON.stringify(visible.body).includes('only-for-disposable-integration-test'));

    const adminA=await http.get('/api/v1/admin/workspace/finance/charges').set('Authorization',ta);
    assert.equal(adminA.status,200,JSON.stringify(adminA.body));
    assert.ok(adminA.body.data.some(x=>x.id===ca));
    assert.ok(!adminA.body.data.some(x=>x.id===cb));
    assert.equal((await http.post(`/api/v1/admin/workspace/finance/charges/${cb}/manual`).set('Authorization',ta)
      .send({reference:`manual-${suffix}`})).status,404);
    assert.equal((await http.post(`/api/v1/admin/workspace/finance/charges/${cb}/cancel`).set('Authorization',ta)
      .send({reason:'ID de outro administrador'})).status,404);
    assert.equal((await http.get('/api/v1/admin/finance-networks/charges').set('Authorization',ta)).status,403);
    assert.equal((await http.get('/api/v1/admin/system/vps').set('Authorization',ta)).status,403);
    assert.equal((await http.post('/api/v1/admin/users').set('Authorization',ta)
      .send({name:'intruso',email:'intruso@example.test',role:'superadmin'})).status,403);
    const adminB=await http.get('/api/v1/admin/workspace/finance/charges').set('Authorization',tb);
    assert.ok(adminB.body.data.some(x=>x.id===cb));
    assert.ok(!adminB.body.data.some(x=>x.id===ca));
    const central=await http.get('/api/v1/admin/finance-networks/charges').set('Authorization',tr);
    assert.equal(central.status,200,JSON.stringify(central.body));
    assert.ok(central.body.data.some(x=>x.id===ca));
    assert.ok(central.body.data.some(x=>x.id===cb));
    const cancel=await http.post(`/api/v1/admin/finance-networks/charges/${ca}/cancel`).set('Authorization',tr)
      .send({reason:'Cancelamento controlado pela DeltaTV'});
    assert.equal(cancel.status,200,JSON.stringify(cancel.body));
    assert.equal((await http.post(`/api/v1/admin/finance-networks/charges/${ca}/cancel`).set('Authorization',tr)
      .send({reason:'Cancelamento repetido'})).status,409);
    assert.ok(await db.AuditLog.findOne({where:{action:'network.finance.charge.super_cancel',entityId:ca}}));
  });
}
