/** Contador do tráfego de saída do NODE no espelho PlayerWeb.
 * Sem IP, URL, token, MAC ou credenciais. Nginx X-Accel e 302 ficam marcados
 * como NÃO MEDIDOS, sem atribuir ficticiamente zero GB consumidos pelo host.
 */
import {randomUUID} from 'node:crypto';
import {sequelize} from '../../db/models/index.js';
import {instrumentPortalResponse,byteLen} from './meter-wire.js';

const ZERO_UUID='00000000-0000-0000-0000-000000000000';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KEYS=30_000;
let queue=new Map();
const pending=[];
let flushing=null, timer=null, pressure=false, lastSuccess=null, failedFlushes=0;
const sessions=new Map(); // playerweb session IDs, process-local; TTL para HLS
const liveSessions=new Map(); // conexões TS longas ainda abertas
const hour=at=>new Date(Math.floor(at/3_600_000)*3_600_000).toISOString();
const keyFor=r=>[r.bucketAt,r.partnerId,r.deviceId,r.mediaKind,r.transport].join(':');
const safeKind=kind=>['live','movie','series','hls','api','epg'].includes(kind)?kind:'api';

function add({partnerId,deviceId=ZERO_UUID,kind,transport,at=Date.now(),bytes=0,requests=0,errors=0,durationMs=0}) {
  if(!UUID.test(partnerId))return;
  if(!UUID.test(deviceId))deviceId=ZERO_UUID;
  const mediaKind=safeKind(kind), bucketAt=hour(at);
  // Quando o banco está indisponível, agregue por parceiro para manter a RAM limitada.
  if(queue.size>=MAX_KEYS) {deviceId=ZERO_UUID;pressure=true;}
  const row={bucketAt,partnerId,deviceId,mediaKind,transport,bytesOut:0,requestCount:0,errorCount:0,durationMs:0};
  const key=keyFor(row), current=queue.get(key)||row;
  current.bytesOut+=bytes;current.requestCount+=requests;current.errorCount+=errors;current.durationMs+=durationMs;
  queue.set(key,current);
}
function touchSession(partnerId,sessionId,at=Date.now()) {
  if(!UUID.test(partnerId)||!UUID.test(sessionId))return;
  sessions.set(`${partnerId}:${sessionId}`,at);
  if(sessions.size>30_000)pruneSessions(at);
}
function pruneSessions(now=Date.now()) {for(const [key,at] of sessions)if(now-at>90_000)sessions.delete(key);}
export function activeViewers(partnerIds=null) {
  pruneSessions(); const owners=new Set(partnerIds||[]), count={};
  const ids=new Set([...sessions.keys(),...liveSessions.keys()]);
  for(const key of ids) {const partnerId=key.slice(0,36);if(!partnerIds||owners.has(partnerId))count[partnerId]=(count[partnerId]||0)+1;}
  return count;
}

/** Instrumentação única de resposta no Node, com contagem sem I/O por chunk. */
export function trackPortalResponse(res,details) {return instrumentPortalResponse(res,details,{add,touchSession,liveSessions,isUuid:id=>UUID.test(id)});}
const INGEST_SQL=`INSERT INTO partner_portal_usage_hourly
 (bucket_at,partner_id,device_id,media_kind,transport,bytes_out,request_count,error_count,duration_ms)
 SELECT x.bucket_at::timestamptz,x.partner_id::uuid,x.device_id::uuid,x.media_kind,x.transport,
 x.bytes_out,x.request_count,x.error_count,x.duration_ms
 FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS x(
 bucket_at text,partner_id text,device_id text,media_kind text,transport text,
 bytes_out bigint,request_count bigint,error_count bigint,duration_ms bigint)
 ON CONFLICT (bucket_at,partner_id,device_id,media_kind,transport) DO UPDATE
 SET bytes_out=partner_portal_usage_hourly.bytes_out+EXCLUDED.bytes_out,
 request_count=partner_portal_usage_hourly.request_count+EXCLUDED.request_count,
 error_count=partner_portal_usage_hourly.error_count+EXCLUDED.error_count,
 duration_ms=partner_portal_usage_hourly.duration_ms+EXCLUDED.duration_ms`;
const mapRow=r=>({bucket_at:r.bucketAt,partner_id:r.partnerId,device_id:r.deviceId,media_kind:r.mediaKind,transport:r.transport,bytes_out:r.bytesOut,request_count:r.requestCount,error_count:r.errorCount,duration_ms:r.durationMs});
export async function flushPortalUsage() {
  if(flushing)return flushing;
  if(queue.size){pending.push({batchId:randomUUID(),rows:[...queue.values()].map(mapRow)});queue=new Map();}
  if(!pending.length)return {flushed:0};
  flushing=(async()=>{
    let done=0;
    while(pending.length) {
      const batch=pending[0];
      // Batch UUID persistido na mesma transação: retry incerto não duplica GB.
      await sequelize.transaction(async transaction=>{
        const [inserted]=await sequelize.query(`INSERT INTO partner_portal_usage_flushes(batch_id)
           VALUES (:id) ON CONFLICT DO NOTHING RETURNING batch_id`,{replacements:{id:batch.batchId},transaction});
        if(inserted.length)await sequelize.query(INGEST_SQL,{replacements:{rows:JSON.stringify(batch.rows)},transaction});
      });
      done+=batch.rows.length;
      pending.shift();
    }
    lastSuccess=new Date().toISOString();failedFlushes=0;return {flushed:done};
  })().catch(e=>{failedFlushes++;throw e}).finally(()=>{flushing=null});
  return flushing;
}
export function usageMeterStatus(){return {pendingKeys:queue.size,pendingBatches:pending.length,failedFlushes,lastSuccess,underMemoryPressure:pressure,flushIntervalSeconds:30,source:'node_outgoing_response_bytes'};}
export function startPortalUsageMeter(){if(timer)return;timer=setInterval(()=>void flushPortalUsage().catch(e=>console.warn('[portal-usage] flush:',e.message)),30_000);timer.unref?.();}
export async function stopPortalUsageMeter(){if(timer){clearInterval(timer);timer=null;}await flushPortalUsage();}
export const __meterTest={reset:()=>{queue.clear();pending.length=0;sessions.clear();liveSessions.clear();pressure=false;},snapshot:()=>[...queue.values()],hour,byteLen};
