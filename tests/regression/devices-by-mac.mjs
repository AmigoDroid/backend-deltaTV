// Run: NODE_ENV=test node --test tests/regression/devices-by-mac.mjs
// Executes the production Sequelize-generated filter/page SQL in embedded PostgreSQL.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Op } from 'sequelize';
import Utils from 'sequelize/lib/utils';
import { sequelize, Device, Activation, AuditLog, AdminUser, WebAccess } from '../../src/db/models/index.js';
import { listDevices, deviceHistory } from '../../src/modules/devices/device.service.js';
import migration from '../../src/db/migrations/20261124000001-audit-device-mac-index.cjs';
import Sequelize from 'sequelize';
const db = new PGlite();
const gen=sequelize.getQueryInterface().queryGenerator;
const fields=(model)=>Object.entries(model.rawAttributes).map(([name,attr])=>[attr.field,name]);
const instance=row=>({...row,toJSON(){return {...row}}});
const deviceFields=['id','mac','platform',['last_seen_at','lastSeenAt'],['created_at','createdAt'],['updated_at','updatedAt']];
mock.method(Device,'findAndCountAll',async options=>{
 const rows=await db.query(gen.selectQuery('devices',{...options,attributes:[...deviceFields,...options.attributes.include]},Device));
 const count=await db.query(gen.selectQuery('devices',{where:options.where,attributes:[[sequelize.fn('count',sequelize.col('id')),'total']]},Device));
 return {rows:rows.rows.map(instance),count:Number(count.rows[0].total)};
});
mock.method(Device,'findOne',async({where})=>{
 const result=await db.query('SELECT * FROM devices WHERE mac=$1',[where.mac]);return result.rows[0]?instance(result.rows[0]):null;
});
mock.method(Activation,'findAll',async({where})=>{
 const ids=typeof where.deviceId==='object'?where.deviceId[Op.in]:[where.deviceId];
 const result=await db.query('SELECT id,device_id AS "deviceId",mac,status,activated_at AS "activatedAt",revoked_at AS "revokedAt" FROM activations WHERE device_id=ANY($1)'+(where.status?" AND status<>'revoked'":"")+' ORDER BY activated_at DESC,id DESC',[ids]);
 return result.rows.map(instance);
});
mock.method(WebAccess,'findAll',async()=>[{id:'web-a'}]);
mock.method(AdminUser,'findAll',async()=>[{id:'11111111-1111-4111-8111-111111111111',name:'Administrador'}]);
mock.method(AuditLog,'findAndCountAll',async options=>{
 options = {...options,where:Utils.mapWhereFieldNames(options.where,AuditLog)};
 const rows=await db.query(gen.selectQuery('audit_logs',{...options,attributes:['id',['entity_type','entityType'],['entity_id','entityId'],['actor_type','actorType'],['actor_id','actorId'],'action','metadata','result',['created_at','createdAt']]},AuditLog));
 const count=await db.query(gen.selectQuery('audit_logs',{where:options.where,attributes:[[sequelize.fn('count',sequelize.col('id')),'total']]},AuditLog));
 return {rows:rows.rows.map(instance),count:Number(count.rows[0].total)};
});
before(async()=>{
 await db.exec(`CREATE TABLE devices(id text PRIMARY KEY,mac text UNIQUE,platform text,last_seen_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE activations(id text PRIMARY KEY,device_id text,mac text,status text,activated_at timestamptz DEFAULT now(),revoked_at timestamptz);
 CREATE TABLE audit_logs(id bigint,entity_type text,entity_id text,actor_type text,actor_id text,action text,metadata jsonb,result text,created_at timestamptz);
 INSERT INTO devices(id,mac,platform,last_seen_at) VALUES ('a','AA:BB:CC:DD:EE:01','roku',now()),('b','AA:BB:CC:DD:EE:02','webos',NULL),('c','AA:BB:CC:DD:EE:03','tizen',NULL),('d','AA:BB:CC:DD:EE:04','web',NULL),('e','AA:BB:CC:DD:EE:05','roku',NULL),('no-mac',NULL,'webos',NULL);
 INSERT INTO activations(id,device_id,mac,status) VALUES ('a-live','a','AA:BB:CC:DD:EE:01','active'),('a-blocked','a','AA:BB:CC:DD:EE:01','blocked'),('b-removed','b','AA:BB:CC:DD:EE:02','revoked'),('d-blocked','d','AA:BB:CC:DD:EE:04','blocked'),('e-live','e','AA:BB:CC:DD:EE:05','active');
 INSERT INTO activations(id,device_id,mac,status) SELECT 'old-'||n,'a','AA:BB:CC:DD:EE:01','revoked' FROM generate_series(1,25) n;
 INSERT INTO audit_logs VALUES
 (1,'activation','a-live','admin','11111111-1111-4111-8111-111111111111','activation.create','{}','success','2026-11-01'),
 (2,'device','a','admin',NULL,'device.configuration.confirm','{"actorName":"Responsável","reason":"Troca de parceiro"}','success','2026-11-02'),
 (3,'activation','deleted-activation','admin',NULL,'activation.delete.admin','{"mac":"AA:BB:CC:DD:EE:01"}','success','2026-11-03'),
 (4,'device','a','device',NULL,'device.register','{}','success','2026-11-04'),
 (5,'web_access','web-a','admin',NULL,'web_access.update','{}','success','2026-11-04'),
 (6,'device','other','admin',NULL,'device.configuration.confirm','{"mac":"AA:BB:CC:DD:EE:99"}','success','2026-11-05');`);
});
after(async()=>db.close());

test('many current/removed activations yield one row per MAC and database pagination counts devices',async()=>{
 const page=await listDevices({page:1,pageSize:20});
 assert.equal(page.meta.total,5);assert.equal(new Set(page.data.map(d=>d.mac)).size,5);
 const a=page.data.find(d=>d.deviceId==='a');assert.equal(a.currentCount,2);assert.equal(a.removedCount,25);assert.equal(a.status,'active');
 const first=await listDevices({page:1,pageSize:2}),second=await listDevices({page:2,pageSize:2}),third=await listDevices({page:3,pageSize:2});
 assert.equal(first.meta.totalPages,3);assert.equal(new Set([...first.data,...second.data,...third.data].map(d=>d.mac)).size,5);
});

test('MAC search, mutually exclusive aggregate status filters and connection filters execute correctly',async()=>{
 const run=opts=>listDevices({page:1,pageSize:20,...opts});
 assert.deepEqual((await run({status:'active'})).data.map(d=>d.deviceId).sort(),['a','e']);
 assert.deepEqual((await run({status:'blocked'})).data.map(d=>d.deviceId),['d']);
 assert.deepEqual((await run({status:'revoked'})).data.map(d=>d.deviceId),['b']);
 assert.deepEqual((await run({status:'unlinked'})).data.map(d=>d.deviceId),['c']);
 assert.equal((await run({q:'aabbccddee01'})).data[0].deviceId,'a');
 assert.equal((await run({online:'true'})).meta.total,1);assert.equal((await run({online:'false'})).meta.total,4);
});

test('one MAC history includes all removed lists, deleted activation audits and web changes with event pagination',async()=>{
 const first=await deviceHistory('aabbccddee01',{page:1,pageSize:2});
 assert.equal(first.activations.length,27);assert.equal(first.eventsMeta.total,4);assert.equal(first.eventsMeta.totalPages,2);
 assert.deepEqual(first.events.map(e=>Number(e.id)),[5,3]);
 const second=await deviceHistory('AA:BB:CC:DD:EE:01',{page:2,pageSize:2});
 assert.deepEqual(second.events.map(e=>Number(e.id)),[2,1]);
 assert.equal(second.events[0].actorName,'Responsável');assert.equal(second.events[1].actorName,'Administrador');
 assert.equal(second.events[0].metadata.reason,'Troca de parceiro');
});

test('audit MAC index migration uses valid PostgreSQL expression and is reversible',async()=>{
 const qi={addIndex:async(table,indexFields,options)=>db.exec(gen.addIndexQuery(table,indexFields,options)),removeIndex:async(table,name)=>db.exec(gen.removeIndexQuery(table,name))};
 await migration.up(qi,Sequelize);
 assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE indexname='ix_audit_device_mac_created'")).rows.length,1);
 await migration.down(qi);
 assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE indexname='ix_audit_device_mac_created'")).rows.length,0);
});
