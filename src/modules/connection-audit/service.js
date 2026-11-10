import { touchDevice } from '../devices/presence.js';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { notFound } from '../../shared/errors.js';

export function safeOrigin(value) {
 try { const u=new URL(value); return ['http:','https:'].includes(u.protocol) && u.origin.length<=512 ? u.origin : null; } catch { return null; }
}
export const ipFamily=value=>isIP(String(value||'').replace(/^::ffff:/i,''))||null;
const samples=new Map();
let lastCleanup=0, pending=0, lastWarning=0;
const query=(sql,replacements)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT});
export async function ownership(id) {
 return (await query(`SELECT a.id, a.device_id, a.partner_id, COALESCE(g.owner_partner_id,l.owner_partner_id) reseller_id
 FROM activations a LEFT JOIN licenses g ON g.id=a.granted_license_id LEFT JOIN licenses l ON l.id=a.license_id
 WHERE a.id=:id`,{id}))[0];
}
export function canRead(owner, partnerId) { return !!owner && (!partnerId || owner.partner_id===partnerId || owner.reseller_id===partnerId); }

// Apenas campos permitidos: nunca gravar URL de mídia, query, senha, token ou mensagens da origem.
export async function record(event) {
 const receivedAt=new Date();
 const owner=await ownership(event.activationId);
 if(!owner)return;
 if(event.source==='tv')touchDevice(owner.device_id);
 const values={received:receivedAt,family:event.clientFamily||null,upfamily:event.upstreamFamily||null,latency:Number.isFinite(event.latencyMs)?Math.min(2147483647,Math.max(0,event.latencyMs)):null,id:randomUUID(),activation:owner.id,session:event.sessionId||null,partner:owner.partner_id,reseller:owner.reseller_id,
 source:event.source,state:event.state,origin:safeOrigin(event.origin),selected:safeOrigin(event.selectedOrigin),
 provider:event.providerId||null,transport:event.transport||null,status:event.statusCode||null,
 error:event.errorCode ? String(event.errorCode).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64):null,
 position:Number.isFinite(event.position)?Math.max(0,Math.floor(event.position)):null,
 build:event.build||null,playback:event.playbackId||null};
 const columns='id,activation_id,session_id,partner_id,reseller_id,source,state,origin,selected_origin,provider_id,transport,status_code,error_code,position,build,playback_id,client_family,upstream_family,latency_ms,created_at';
 const changes=['session_id','partner_id','reseller_id','state','origin','selected_origin','provider_id','transport','status_code','error_code','playback_id'];
 const changed=changes.map(c=>`device_connection_latest.${c} IS DISTINCT FROM EXCLUDED.${c}`).join(' OR ');
 const updates=columns.split(',').filter(c=>!['activation_id','source'].includes(c)).map(c=>`${c}=EXCLUDED.${c}`).join(',');
 // O estado atual recebe cada sinal; o histórico só recebe mudanças ou uma amostra a cada 5 minutos.
 await sequelize.query(`WITH updated AS (
  INSERT INTO device_connection_latest (${columns},last_event_at)
  VALUES (:id,:activation,:session,:partner,:reseller,:source,:state,:origin,:selected,:provider,:transport,:status,:error,:position,:build,:playback,:family,:upfamily,:latency,:received,:received)
  ON CONFLICT (activation_id,source) DO UPDATE SET ${updates},last_event_at=CASE
   WHEN (${changed}) OR device_connection_latest.last_event_at < NOW()-INTERVAL '5 minutes' THEN EXCLUDED.created_at
   ELSE device_connection_latest.last_event_at END
  WHERE device_connection_latest.created_at <= EXCLUDED.created_at
  RETURNING *
 ) INSERT INTO device_connection_events (${columns}) SELECT ${columns} FROM updated WHERE last_event_at=created_at`,{replacements:values});
 // Limpeza incremental global, limitada a 1.000 registros por minuto, inclusive em múltiplos processos.
 if(Date.now()-lastCleanup>60000){lastCleanup=Date.now();
  await sequelize.query(`DELETE FROM device_connection_events WHERE id IN
   (SELECT id FROM device_connection_events WHERE created_at < NOW()-INTERVAL '7 days' ORDER BY created_at LIMIT 1000)`);
 }
}
// Coalesce segmentos HLS iguais e nunca bloquear a reprodução por indisponibilidade da auditoria.
export function observe(event) {
 const key=[event.activationId,event.sessionId,event.source].join('|');
 const signature=[event.state,event.statusCode,event.errorCode,event.transport,safeOrigin(event.origin),safeOrigin(event.selectedOrigin)].join('|');
 const now=Date.now(),last=samples.get(key); if((last?.signature===signature && now-last.at<30000) || pending>=100)return;
 samples.set(key,{signature,at:now}); if(samples.size>10000)samples.delete(samples.keys().next().value);
 pending++;
 void record(event).catch(()=>{ samples.delete(key); if(Date.now()-lastWarning>60000){lastWarning=Date.now();console.warn('[connection-audit] Não foi possível persistir o diagnóstico; reprodução preservada.');} }).finally(()=>{pending--;});
}
export function connectionObserver(ctx, req, selectedOrigin, providerId) {
 let last={origin:selectedOrigin};
 return detail=>{last={...last,...detail};observe({activationId:ctx.activationId||ctx.activation?.id,sessionId:ctx.sessionId||ctx.session?.id,
  source:'server',selectedOrigin,providerId,clientFamily:ipFamily(req.ip),...last});};
}
export async function readAudit(id, partnerId, before, beforeId) {
 const owner=await ownership(id); if(!canRead(owner,partnerId))throw notFound('Dispositivo');
 const scope=partnerId?' AND (partner_id=:partner OR reseller_id=:partner)':'';
 const replacements={id,partner:partnerId||null,before:before||new Date().toISOString(),beforeId:beforeId||'ffffffff-ffff-ffff-ffff-ffffffffffff'};
 const base=`activation_id=:id AND created_at>NOW()-INTERVAL '7 days'${scope}`;
 const events=await query(`SELECT * FROM device_connection_events WHERE ${base} AND (created_at,id) < (:before,:beforeId) ORDER BY created_at DESC,id DESC LIMIT 51`,replacements);
 const latest=await query(`SELECT * FROM device_connection_latest WHERE ${base} ORDER BY source`,replacements);
 const client=latest.find(e=>e.source==='tv');
 let fresh=!!client && Date.now()-new Date(client.created_at).getTime()<90000;
 if(fresh && client.session_id){const sessions=await query('SELECT id FROM device_sessions WHERE id=:sid AND revoked_at IS NULL AND expires_at>NOW()',{sid:client.session_id});fresh=sessions.length>0;}
 return {events:events.slice(0,50),nextBefore:events.length>50?{before:events[49].created_at,beforeId:events[49].id}:null,latest,
  playbackFresh:fresh,serverTime:new Date().toISOString(),retentionDays:7};
}
