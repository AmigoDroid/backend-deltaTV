import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const dir=new URL('../../src/db/migrations/',import.meta.url);
const migration=require('../../src/db/migrations/20261217000001-tv-messages.cjs');

function fakeQ(schema={}) {
  const tables = new Map(Object.entries(schema).map(([name,cols])=>[name,new Set(cols)]));
  const ownership=new Map();
  const rows=new Map();
  const calls=[];
  const query=async (sql)=> {
    calls.push(sql);
    const table=sql.match(/table_name='(tv_message_\w+)'/)?.[1];
    if(table) return [...(tables.get(table)||[])].map(column_name=>({column_name}));
    const created=sql.match(/CREATE TABLE IF NOT EXISTS (tv_message_\w+)/i)?.[1];
    if(created&&!tables.has(created)) tables.set(created,new Set(created.endsWith('campaigns')?['id','sender_id','partner_id']:['campaign_id','device_id']));
    const marked=sql.match(/COMMENT ON TABLE (tv_message_\w+) IS '([^']+)'/i);
    if(marked) ownership.set(marked[1],marked[2]);
    const owner=sql.match(/obj_description\(to_regclass\('public\.(tv_message_\w+)'\)/)?.[1];
    if(owner) return [{owner:ownership.get(owner)||null}];
    const counted=sql.match(/SELECT EXISTS\(SELECT 1 FROM (tv_message_\w+)/i)?.[1];
    if(counted) return [{has_rows:rows.get(counted)||false}];
    const dropped=sql.match(/^DROP TABLE (tv_message_\w+)/i)?.[1];
    if(dropped) tables.delete(dropped);
    return [];
  };
  return {calls,tables,rows,sequelize:{QueryTypes:{SELECT:'SELECT'},transaction:fn=>fn({test:true}),query}};
}

test('20261217 é idempotente após 20261212 e não derruba tabelas legadas no down',async()=>{
  const q=fakeQ({tv_message_campaigns:['id','sender_id','partner_id','payload_hash'],tv_message_deliveries:['campaign_id','device_id']});
  await migration.up(q);await migration.up(q);await migration.down(q);
  assert.equal(q.calls.filter(sql=>/CREATE TABLE|DROP TABLE/i.test(sql)).length,0);
  assert.equal(q.tables.size,2);
});

test('20261217 cria somente tabelas ausentes, e down só remove tabelas vazias que criou',async()=>{
  const q=fakeQ();await migration.up(q);
  assert.equal(q.tables.size,2);
  assert.equal(q.calls.filter(sql=>/CREATE TABLE/i.test(sql)).length,2);
  await migration.up(q);
  assert.equal(q.calls.filter(sql=>/CREATE TABLE/i.test(sql)).length,2);
  q.rows.set('tv_message_deliveries',true);
  await assert.rejects(migration.down(q),/TV_MESSAGES_DOWN_HAS_DATA/);
  q.rows.delete('tv_message_deliveries');
  await migration.down(q);
  assert.equal(q.tables.size,0);
});

test('20261217 preserva esquema alternativo para normalização posterior',async()=>{
  const q=fakeQ({tv_message_campaigns:['id','sender_user_id','request_hash'],tv_message_deliveries:['id','campaign_id']});
  await migration.up(q);
  assert.ok(!q.calls.some(sql=>/CREATE TABLE|ALTER TABLE|DROP TABLE/i.test(sql)));
});

test('uma tabela compartilhada entre migrations só pode ser recriada de modo guardado',()=>{
  const seen=new Map();
  for (const f of readdirSync(dir).filter(x=>x.endsWith('.cjs'))) {
    const src=readFileSync(new URL(f,dir),'utf8');
    for (const m of src.matchAll(/create\s+table\s+(if\s+not\s+exists\s+)?"?([a-z_]+)"?|createTable\(\s*['"]([a-z_]+)/gi)) {
      const table=(m[2]||m[3]).toLowerCase();
      if(seen.has(table)) assert.ok(m[1],`${table}: criação repetida sem IF NOT EXISTS em ${f}`);
      seen.set(table,f);
    }
  }
});

test('rotas de mensagens continuam montadas sobre o esquema legado',()=>{
  const app=readFileSync(new URL('../../src/app.js',import.meta.url),'utf8');
  assert.match(app,/app\.use\("\/api\/v1\/tv-messages",\s*panelMessages\)/);
  assert.match(app,/app\.use\("\/api\/v1\/client\/messages",\s*clientMessages\)/);
  assert.ok(app.indexOf('"/api/v1/client/messages"')<app.indexOf('app.use("/api/v1/client", clientRoutes)'));
});
