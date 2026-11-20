#!/usr/bin/env node
/** Exercise up/down ONLY in disposable local copy; no production DB accepted. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Sequelize} from 'sequelize';
const require=createRequire(import.meta.url);
const url=process.env.DATABASE_URL_TEST;
if(process.env.DELTA_FINANCE_DB_CONFIRM!=='DISPOSABLE'||!url||
  !['localhost','127.0.0.1','::1'].includes(new URL(url).hostname)){
  console.error('Operação recusada: use apenas DATABASE_URL_TEST local e DELTA_FINANCE_DB_CONFIRM=DISPOSABLE.');
  process.exit(2);
}
const orm=new Sequelize(url,{logging:false}),q=orm.getQueryInterface();
const step=[
 require('../src/db/migrations/20270111000001-hidden-network-plans.cjs'),
 require('../src/db/migrations/20270112000001-network-charge-recovery.cjs'),
 require('../src/db/migrations/20270113000001-network-review-charge-exclusivity.cjs'),
];
try{
 const [[hidden]] = await orm.query(`SELECT count(*)::int n FROM service_plan_catalogs WHERE hidden_from_network=true`);
 const [[retries]] = await orm.query(`SELECT count(*)::int n FROM admin_network_charges WHERE recovery_attempts>0`);
 if(hidden.n||retries.n)throw new Error('Rollback recusado: há dados ativos nas colunas de visibilidade/recuperação. Use outra cópia descartável.');
 const [[before]]=await orm.query('SELECT count(*)::int n FROM tv_message_campaigns');
 // Always return the disposable clone to its most recent schema if no error.
 await step[2].down(q);await step[1].down(q);await step[0].down(q);
 await step[0].up(q,Sequelize);await step[1].up(q);await step[2].up(q);
 const [[after]]=await orm.query('SELECT count(*)::int n FROM tv_message_campaigns');
 assert.equal(after.n,before.n);
 console.log('Migrations 20270111, 12, 13: down/up em banco copiado com dados PASSARAM.');
}catch(e){console.error('Migrations de finanças: FALHA',e.code||e.message);process.exitCode=1;
}finally{await orm.close();}
