/** Contador do tráfego de saída do NODE no espelho PlayerWeb.
 * Sem IP, URL, token, MAC ou credenciais. Nginx X-Accel e 302 ficam marcados
 * como NÃO MEDIDOS, sem atribuir ficticiamente zero GB consumidos pelo host.
 */
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,readdir,readFile,unlink,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {sequelize} from '../../db/models/index.js';
import {instrumentPortalResponse,byteLen} from './meter-wire.js';

const ZERO_UUID='00000000-0000-0000-0000-000000000000';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_KEYS=30_000;
// Spool local durável: uma pane prolongada do PostgreSQL não acumula arrays
// ilimitados em RAM. Em produção, disponibilizar diretório persistente/monitorado.
const SPOOL_DIR = resolve(process.env.PORTAL_USAGE_SPOOL_DIR || './var/portal-usage-spool');
const MAX_SPOOL_BYTES = Math.max(16,Math.min(2048,Number(process.env.PORTAL_USAGE_SPOOL_MAX_MB)||256))*1024*1024;
let queue=new Map();
let flushing=null, timer=null, pressure=false, lastSuccess=null, failedFlushes=0;
let spoolFiles=0, spoolBytes=0, spoolError=null, unrecordedMeasurements=0;

const sessions=new Map(); // playerweb session IDs, process-local; TTL para HLS
const liveSessions=new Map(); // conexões TS longas ainda abertas
const hour=at=>new Date(Math.floor(at/3_600_000)*3_600_000).toISOString();
const keyFor=r=>[r.bucketAt,r.partnerId,r.deviceId,r.mediaKind,r.transport].join(':');
const safeKind=kind=>['live','movie','series','hls','api','epg'].includes(kind)?kind:'api';

function add({partnerId,deviceId=ZERO_UUID,kind,transport,at=Date.now(),bytes=0,requests=0,errors=0,durationMs=0}) {
  if(!UUID.test(partnerId))return;
  if(!UUID.test(deviceId))deviceId=ZERO_UUID;
  const mediaKind=safeKind(kind), bucketAt=hour(at);
  // Sob pressão, agregar somente o dispositivo; preservar parceiro, hora e mídia.
  if(queue.size>=MAX_KEYS) {deviceId=ZERO_UUID;pressure=true;}
  const row={bucketAt,partnerId,deviceId,mediaKind,transport,bytesOut:0,requestCount:0,errorCount:0,durationMs:0};
  let key=keyFor(row);
  if(queue.size>=MAX_KEYS && !queue.has(key)) {
    // Não criar mapa infinito se banco e disco estiverem indisponíveis.
    // A lacuna é EXPLÍCITA no diagnóstico: jamais mostrar contabilidade completa.
    unrecordedMeasurements++;
    if(unrecordedMeasurements===1 || unrecordedMeasurements%10000===0)
      console.error('[portal-usage] LIMITE DE MEMÓRIA: medições não persistidas. Confira spool e PostgreSQL.');
    return;
  }
  const current=queue.get(key)||row;
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
async function listSpool() {
  await mkdir(SPOOL_DIR,{recursive:true,mode:0o700});
  const files=(await readdir(SPOOL_DIR)).filter(name=>/^usage-[0-9]+-[a-f0-9-]{36}\.json$/.test(name)).sort();
  const sizes=await Promise.all(files.map(async name=>(await stat(join(SPOOL_DIR,name))).size));
  spoolFiles=files.length;spoolBytes=sizes.reduce((a,b)=>a+b,0);
  return files;
}
async function persistQueue() {
  if(!queue.size)return;
  // Só liberar os dados da memória após a gravação atômica no disco.
  const batchId=randomUUID(),rows=[...queue.values()].map(mapRow);
  const body=JSON.stringify({batchId,rows}),bytes=Buffer.byteLength(body);
  await listSpool();
  if(spoolBytes+bytes>MAX_SPOOL_BYTES) {
    pressure=true;
    throw new Error('Spool do PlayerWeb cheio; aumente espaço/recupere PostgreSQL (não será descartado silenciosamente).');
  }
  const path=join(SPOOL_DIR,`usage-${String(Date.now()).padStart(13,'0')}-${batchId}.json`);
  const temporary=`${path}.tmp`;
  await writeFile(temporary,body,{mode:0o600,flag:'wx'});
  try{await rename(temporary,path)}catch(e){await unlink(temporary).catch(()=>{});throw e}
  // Eventos adicionados durante o await não devem ser apagados.
  const committed=new Map(rows.map(row=>[keyFor({bucketAt:row.bucket_at,partnerId:row.partner_id,
    deviceId:row.device_id,mediaKind:row.media_kind,transport:row.transport}),row]));
  for(const [key,item] of queue){
    const snap=committed.get(key);if(!snap)continue;
    // Preservar incrementos recebidos enquanto o disco gravava o lote.
    item.bytesOut-=Number(snap.bytes_out);item.requestCount-=Number(snap.request_count);
    item.errorCount-=Number(snap.error_count);item.durationMs-=Number(snap.duration_ms);
    if(!item.bytesOut&&!item.requestCount&&!item.errorCount&&!item.durationMs)queue.delete(key);
  }
  spoolFiles++;spoolBytes+=bytes;
}
export async function flushPortalUsage() {
  if(flushing)return flushing;
  flushing=(async()=>{
    await persistQueue();
    const files=await listSpool();
    let done=0;
    for(const file of files){
      const path=join(SPOOL_DIR,file);
      const batch=JSON.parse(await readFile(path,'utf8'));
      // Batch UUID persistido na mesma transação: retry incerto não duplica GB.
      await sequelize.transaction(async transaction=>{
        const [inserted]=await sequelize.query(`INSERT INTO partner_portal_usage_flushes(batch_id)
           VALUES (:id) ON CONFLICT DO NOTHING RETURNING batch_id`,{replacements:{id:batch.batchId},transaction});
        if(inserted.length)await sequelize.query(INGEST_SQL,{replacements:{rows:JSON.stringify(batch.rows)},transaction});
      });
      done+=batch.rows.length;
      await unlink(path); // somente após commit confirmado
    }
    spoolError=null;lastSuccess=new Date().toISOString();failedFlushes=0;
    await listSpool();return {flushed:done};
  })().catch(e=>{spoolError=e.message;failedFlushes++;pressure=true;throw e}).finally(()=>{flushing=null});
  return flushing;
}
export function usageMeterStatus(){return {pendingKeys:queue.size,pendingBatches:spoolFiles,spoolBytes,
  spoolError,spoolDirConfigured:Boolean(process.env.PORTAL_USAGE_SPOOL_DIR),
  unrecordedMeasurements,accountingComplete:unrecordedMeasurements===0&&!spoolError,
  failedFlushes,lastSuccess,underMemoryPressure:pressure,flushIntervalSeconds:30,source:'node_outgoing_response_bytes'};}
export function startPortalUsageMeter(){if(timer)return;timer=setInterval(()=>void flushPortalUsage().catch(e=>console.warn('[portal-usage] flush:',e.message)),30_000);timer.unref?.();}
export async function stopPortalUsageMeter(){if(timer){clearInterval(timer);timer=null;}await flushPortalUsage();}
export const __meterTest={reset:()=>{queue.clear();sessions.clear();liveSessions.clear();pressure=false;unrecordedMeasurements=0;},snapshot:()=>[...queue.values()],hour,byteLen};
