import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

test('pacotes globais: convites grátis e pagos, contratos existentes e isolamento', {
  skip: !process.env.DATABASE_URL_TEST && 'Requer PostgreSQL descartável com migrations aplicadas',
}, async () => {
  assert.equal(process.env.DELTA_FINANCE_DB_CONFIRM,'DISPOSABLE');
  process.env.DATABASE_URL=process.env.DATABASE_URL_TEST;
  const [{createApp},db,{hashPassword}]=await Promise.all([
    import('../../src/app.js'),import('../../src/db/models/index.js'),import('../../src/shared/crypto.js')
  ]);
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const tag=randomUUID().slice(0,8);
  const password='Example-Test-Password-69521';
  const request=async(path,{method='GET',body,token,status=200}={})=>{
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`,{method,
      headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json();
    assert.equal(res.status,status,JSON.stringify(data));return data;
  };
  try {
    const login=async role=>{
      const email=role+tag+'@example.test';
      await db.AdminUser.create({email,role,name:role,passwordHash:await hashPassword(password),
        delegatedPermissions:['network:partners:write','network:plans:read']});
      return (await request('/auth/login',{method:'POST',body:{email,password,audience:'admin'}})).accessToken;
    };
    const token=await login('superadmin'), delegated=await login('admin');
    for(const fee of [0,3500]){
      const code='test_'+tag+'_'+fee;
      const body={code,name:'Pacote '+code,monthlyPriceCents:fee,wholesaleCents:fee,minResaleCents:fee,
        activationLimit:9,maxDns:3,maxApps:2,autoFailover:true,autoPriority:false,emailAlerts:false,
        detailedHistory:true,canResellPanel:true,canViewFinance:true,validityDays:12};
      const result=await request('/admin/service-packages',{method:'POST',token,body,status:201});
      const key=result.package.tier;
      const offers=await request('/admin/workspace/invitations/plans?adminId=deltatv',{token});
      const offer=offers.data.find(p=>p.key===key);
      assert.equal(offer.monthlyPriceCents,fee);assert.equal(offer.activationLimit,9);
      const other=await request('/admin/workspace/invitations/plans',{token:delegated});
      assert.ok(!other.data.some(p=>p.key===key));
      await request('/admin/workspace/invitations',{token:delegated,method:'POST',body:{planKey:key},status:422});
      const invitation=await request('/admin/workspace/invitations?adminId=deltatv',{token,method:'POST',body:{planKey:key},status:201});
      const ticket=new URL(invitation.url).pathname.split('/').pop();
      const verified=await request('/auth/admin-network-invite/verify',{method:'POST',body:{token:ticket}});
      assert.equal(verified.monthlyFeeCents,fee);
      const account=await request('/auth/admin-network-invite/complete',{method:'POST',status:201,
        body:{token:ticket,name:'Conta teste',email:code+'@example.test',password}});
      assert.equal(account.status,fee?'suspended':'active');
      const contract=await db.Partner.findOne({where:{contactEmail:code+'@example.test'}});
      assert.equal(contract.monthlyFeeCents,fee);assert.equal(contract.ownerAdminId,null);
      await request('/admin/service-packages/'+code,{method:'PUT',token,body:{...body,monthlyPriceCents:fee+500}});
      assert.equal((await contract.reload()).monthlyFeeCents,fee);
      const [seller]=await db.sequelize.query('SELECT can_view_finance FROM partner_portal_sellers WHERE partner_id=:id',
        {replacements:{id:contract.id}});
      assert.equal(seller[0]?.can_view_finance,true);
      const {generateInvoice,lastClosedCompetence}=await import('../../src/modules/billing/billing.service.js');
      const {competenceBounds}=await import('../../src/shared/dates.js');
      const competence=lastClosedCompetence();
      // Simula um contrato que já estava vigente na competência encerrada.
      await contract.update({startsAt:competenceBounds(competence).start});
      const billed=await generateInvoice(contract.id,competence);
      assert.equal(billed.created,fee>0);
      if(fee)assert.equal(billed.invoice.amountCents,fee);
      else assert.equal(billed.skipped,'ZERO_AMOUNT');
      assert.equal((await db.ServicePlanCatalog.findByPk(key)).canResellPanel,true);
    }
  } finally {
    await new Promise(resolve=>server.close(resolve));await db.sequelize.close();
  }
});
