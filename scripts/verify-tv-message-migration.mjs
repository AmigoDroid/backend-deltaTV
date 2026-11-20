#!/usr/bin/env node
/** LOCAL DISPOSABLE only. Re-executes 20261217 up/up/down without touching SequelizeMeta. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Sequelize} from 'sequelize';
const require=createRequire(import.meta.url);
const migration=require('../src/db/migrations/20261217000001-tv-messages.cjs');
const uri=process.env.DATABASE_URL_TEST;
if(process.env.DELTA_FINANCE_DB_CONFIRM!=='DISPOSABLE'||!uri||
  !['localhost','127.0.0.1','::1'].includes(new URL(uri).hostname)){
  console.error('Exige DATABASE_URL_TEST local descartável e DELTA_FINANCE_DB_CONFIRM=DISPOSABLE.');
  process.exit(2);
}
const sequelize=new Sequelize(uri,{logging:false});
const q=sequelize.getQueryInterface();
try {
  const mode=process.argv.includes('--scratch')?'scratch':'populated';
  if(mode==='scratch'){
    await sequelize.query('CREATE TABLE IF NOT EXISTS devices (id uuid PRIMARY KEY)');
    await sequelize.query('CREATE TABLE IF NOT EXISTS activations (id uuid PRIMARY KEY)');
  } else {
    const name='deltatv-test-migration-20261217';
    await sequelize.query(`INSERT INTO tv_message_campaigns (id,sender_id,request_id,payload_hash,title,message,expires_at)
      VALUES('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111112',
      '11111111-1111-4111-8111-111111111113',repeat('a',64),:name,'Teste de histórico',now()+interval '1 day')
      ON CONFLICT DO NOTHING`,{replacements:{name}});
  }
  const getCount=async()=>{
    const [r]=await sequelize.query("SELECT COUNT(*)::int AS n FROM tv_message_campaigns",{type:Sequelize.QueryTypes.SELECT});
    return r.n;
  };
  const before=mode==='scratch'?0:await getCount();
  await migration.up(q);
  await migration.up(q);
  assert.equal(await getCount(),before);
  await migration.down(q);
  if(mode==='scratch'){
    const [r]=await sequelize.query("SELECT to_regclass('public.tv_message_campaigns') AS t",{type:Sequelize.QueryTypes.SELECT});
    assert.equal(r.t,null,'rollback must remove only empty tables owned by 20261217');
  }else assert.equal(await getCount(),before,'histórico do esquema 20261212 deve permanecer intacto');
  console.log(`TV migration ${mode}: PASSOU (up, up, down e histórico protegido)`);
}catch(e){console.error('TV migration: FALHA',e.code||e.message);process.exitCode=1;
}finally{await sequelize.close();}
