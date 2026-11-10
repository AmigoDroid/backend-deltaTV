import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import Sequelize from 'sequelize';
import sqlUtils from 'sequelize/lib/utils/sql';
import migration from '../../src/db/migrations/20261204000001-device-connection-audit.cjs';
import { sequelize } from '../../src/db/sequelize.js';
import { record, readAudit, safeOrigin, ipFamily } from '../../src/modules/connection-audit/service.js';
import { telemetrySchema, requireTelemetry } from '../../src/modules/connection-audit/routes.js';
import { DeviceSession } from '../../src/db/models/index.js';
import { signJwt, verifyJwt } from '../../src/shared/crypto.js';

test('origins exclude passwords, paths and tokens; IPv4 mapped IPv6 classified correctly',()=>{
 assert.equal(safeOrigin('https://user:password@example.com:8443/live/u/p/1.ts?token=secret'),'https://example.com:8443');
 assert.equal(safeOrigin('file:///etc/passwd'),null);assert.equal(safeOrigin('bad'),null);
 assert.equal(ipFamily('::ffff:1.2.3.4'),4);assert.equal(ipFamily('2001:db8::1'),6);
 const token=signJwt({typ:'telemetry',sid:randomUUID(),aid:randomUUID()},3600);
 assert.equal(verifyJwt(token,'telemetry').typ,'telemetry');assert.throws(()=>verifyJwt(token,'device'));
 assert.equal(telemetrySchema.safeParse({state:'playing',playback_id:randomUUID(),activationId:randomUUID()}).success,false);
});
test('migration, persistence, sampling, scope, stale signals, revocation, retention and cascade',async()=>{
 const db=new PGlite(); const original=sequelize.query;
 sequelize.query=async(sql,options={})=>{
  const text=sqlUtils.injectReplacements(sql,sequelize.dialect,options.replacements||{});
  const result=await db.query(text);return options.type===Sequelize.QueryTypes.SELECT?result.rows:[result.rows,result];
 };
 try{
 await db.exec('CREATE TABLE licenses(id UUID PRIMARY KEY,owner_partner_id UUID); CREATE TABLE activations(id UUID PRIMARY KEY,device_id UUID,partner_id UUID,license_id UUID,granted_license_id UUID); CREATE TABLE device_sessions(id UUID PRIMARY KEY,revoked_at TIMESTAMPTZ,expires_at TIMESTAMPTZ)');
 await migration.up(sequelize.getQueryInterface(),Sequelize);
 const aid=randomUUID(),partner=randomUUID(),reseller=randomUUID(),sid=randomUUID(),license=randomUUID(),stranger=randomUUID();
 await db.query('INSERT INTO licenses VALUES ($1,$2)',[license,reseller]);
 await db.query('INSERT INTO activations VALUES ($1,NULL,$2,NULL,$3)',[aid,partner,license]);
 await db.query("INSERT INTO device_sessions VALUES ($1,NULL,NOW()+INTERVAL '1 day')",[sid]);
 const event={activationId:aid,sessionId:sid,source:'tv',state:'playing',origin:'https://u:p@example.com/live/u/p/1?secret=1',playbackId:randomUUID(),position:1,build:'46',clientFamily:6};
 await record(event);await record({...event,position:30});
 let a=await readAudit(aid,partner);
 assert.equal(a.playbackFresh,true);assert.equal(a.events.length,1);assert.equal(a.latest[0].position,30);assert.equal(a.latest[0].origin,'https://example.com');assert.equal(a.latest[0].client_family,6);
 assert.equal((await readAudit(aid,reseller)).events.length,1);
 await assert.rejects(readAudit(aid,stranger));
 await record({...event,state:'error',errorCode:'-4'});a=await readAudit(aid);assert.equal(a.events.length,2);assert.equal(a.latest[0].state,'error');
 await record({activationId:aid,source:'server',state:'response',origin:'http://cdn.example/live/secret',selectedOrigin:'https://example.com',statusCode:206,transport:'node',upstreamFamily:4,latencyMs:123});
 a=await readAudit(aid);assert.equal(a.latest.length,2);assert.equal(a.latest.find(x=>x.source==='server').latency_ms,123);
 await db.exec("UPDATE device_connection_latest SET created_at=NOW()-INTERVAL '2 minutes' WHERE source='tv'");assert.equal((await readAudit(aid)).playbackFresh,false);
 await record(event);await db.query('UPDATE device_sessions SET revoked_at=NOW() WHERE id=$1',[sid]);assert.equal((await readAudit(aid)).playbackFresh,false);
 await db.query('UPDATE licenses SET owner_partner_id=$1 WHERE id=$2',[stranger,license]);
 assert.equal((await readAudit(aid,stranger)).events.length,0);await assert.rejects(readAudit(aid,reseller));
 await db.exec("UPDATE device_connection_events SET created_at=NOW()-INTERVAL '8 days'");assert.equal((await readAudit(aid)).events.length,0);
 await db.query('DELETE FROM activations WHERE id=$1',[aid]);assert.equal((await db.query('SELECT * FROM device_connection_events')).rows.length,0);assert.equal((await db.query('SELECT * FROM device_connection_latest')).rows.length,0);
 await migration.down(sequelize.getQueryInterface());
 } finally{sequelize.query=original;await db.close();}
});

test('telemetry authentication rejects revoked/expired/mismatched sessions and other token types',async()=>{
 const saved=DeviceSession.findByPk;const sid=randomUUID(),aid=randomUUID();
 let session={id:sid,activationId:aid,expiresAt:new Date(Date.now()+100000)};
 DeviceSession.findByPk=async()=>session;
 const req=()=>({get:()=>`Bearer ${signJwt({typ:'telemetry',sid,aid},3600)}`});
 try{
  let next=false,r=req();await requireTelemetry(r,{},()=>{next=true});assert.ok(next);assert.equal(r.device.activation.id,aid);
  session.revokedAt=new Date();await assert.rejects(requireTelemetry(req(),{},()=>{}));
  session.revokedAt=null;session.expiresAt=new Date(0);await assert.rejects(requireTelemetry(req(),{},()=>{}));
  session.expiresAt=new Date(Date.now()+100000);session.activationId=randomUUID();await assert.rejects(requireTelemetry(req(),{},()=>{}));
  await assert.rejects(requireTelemetry({get:()=>`Bearer ${signJwt({typ:'device',sid,aid},3600)}`},{},()=>{}));
 }finally{DeviceSession.findByPk=saved;}
});
