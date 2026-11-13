"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dir=path.join(__dirname,'../../src/db/migrations');
const names=[
 '20261211000001-phase1-device-identity.cjs',
 '20261211000002-phase2-safe-reconciliation.cjs',
 '20261211000003-phase3-unified-license-readmodel.cjs',
 '20261211000004-phase4-provider-plan-readmodels.cjs',
 '20261211000005-phase5-session-retention-indexes.cjs',
];
function recorder() {
 const events=[];
 return {events,q:{
  sequelize:{query:async (sql,opts={})=> {events.push({sql,opts}); return [[{n:0}]];}, transaction:async cb=>cb({})},
  addColumn:async (...args)=>events.push({api:'addColumn',args}),
  removeColumn:async (...args)=>events.push({api:'removeColumn',args}),
 }};
}
const S={UUID:'UUID'};
test('5 migrations executam em sequência sem exclusões de registros/tabelas', async()=>{
 for(const name of names){
  const {events,q}=recorder();
  await require(path.join(dir,name)).up(q,S);
  const all=events.map(x=>x.sql||'').join('\n');
  assert.ok(events.length>=1,name);
  assert.doesNotMatch(all,/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i,name);
 }
});
test('identidade usa FK opcional (ficha sem dispositivo segue válida)', async()=>{
 const {events,q}=recorder();await require(path.join(dir,names[0])).up(q,S);
 const col=events.find(x=>x.api==='addColumn');
 assert.equal(col.args[0],'reseller_clients');assert.equal(col.args[1],'device_id');
 assert.equal(col.args[2].allowNull,true);assert.equal(col.args[2].references.model,'devices');
});
test('reconciliação exige mesmo parceiro e MAC real do dispositivo',async()=>{
 const {events,q}=recorder();await require(path.join(dir,names[1])).up(q,S);
 const sql=events.map(x=>x.sql).join('\n');
 assert.match(sql,/a\.partner_id\s*=\s*c\.partner_id/);
 assert.match(sql,/d\.mac\s*=\s*c\.mac/);
 assert.match(sql,/count\(DISTINCT a\.device_id\)\s*=\s*1/);
});
test('políticas de licença não são substituídas por view de autorização',async()=>{
 const {events,q}=recorder();await require(path.join(dir,names[2])).up(q,S);
 const sql=events.map(x=>x.sql).join('\n');
 assert.match(sql,/v_delta_device_license_inventory/);
 assert.doesNotMatch(sql,/\ballowed\s+AS|\bauthorized\s+AS/);
});
test('modo de entrega é leitura, credenciais não são expostas',async()=>{
 const {events,q}=recorder();await require(path.join(dir,names[3])).up(q,S);
 const sql=events.map(x=>x.sql).join('\n');
 assert.match(sql,/v_delta_provider_operations/);
 assert.doesNotMatch(sql,/credentials_enc|password|base_url/);
});
test('índices de retenção usam CONCURRENTLY, migration não apaga sessões',async()=>{
 const {events,q}=recorder();await require(path.join(dir,names[4])).up(q,S);
 const sql=events.map(x=>x.sql).join('\n');
 assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g)||[]).length,3);
 assert.doesNotMatch(sql,/DELETE FROM/);
});
test('rollback da identidade recusa apagar vínculos já existentes',async()=>{
 const {events,q}=recorder();
 q.sequelize.query=async (sql)=>[[{n:3}]];
 await assert.rejects(require(path.join(dir,names[0])).down(q),/recusado/);
 assert.equal(events.length,0);
});
