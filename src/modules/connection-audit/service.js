// Somente o ÚLTIMO estado de cada ativação fica em memória, sem histórico persistente.
// Presença online e saúde de DNS permanecem em seus módulos próprios.
import { isIP } from 'node:net';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { notFound } from '../../shared/errors.js';

export function safeOrigin(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && u.origin.length <= 512 ? u.origin : null; }
  catch { return null; }
}
export const ipFamily = value => isIP(String(value || '').replace(/^::ffff:/i, '')) || null;
export async function ownership(id) {
  const [row] = await sequelize.query(`SELECT a.id, a.status, a.device_id, a.partner_id,
    COALESCE(g.owner_partner_id,l.owner_partner_id) reseller_id
    FROM activations a LEFT JOIN licenses g ON g.id=a.granted_license_id
    LEFT JOIN licenses l ON l.id=a.license_id WHERE a.id=:id`,
    {replacements:{id},type:QueryTypes.SELECT});
  return row;
}
export function canRead(owner, partnerId) {
  return !!owner && (!partnerId || owner.partner_id === partnerId || owner.reseller_id === partnerId);
}
// Compatibilidade com clientes antigos: último estado operacional por ativação, sem gravar no PostgreSQL.
const snapshots = new Map();
const MAX_SNAPSHOTS = 30000;
const SNAPSHOT_TTL_MS = 5 * 60_000;
function removeExpired() {
  const cutoff=Date.now()-SNAPSHOT_TTL_MS;
  for(const [activationId,state] of snapshots){
    if(state.at>=cutoff) break; // Map em ordem de atualização (LRU)
    snapshots.delete(activationId);
  }
}
export function observe(event) {
  const id=event?.activationId;
  if(typeof id!=='string' || !/^[0-9a-f-]{36}$/i.test(id))return false;
  // Nunca guardar URL IPTV, IP, senha, token ou payload de mídia.
  const state={
    activation_id:id,
    source:String(event.source||'unknown').slice(0,24),
    state:String(event.state||'unknown').slice(0,32),
    error_code:event.errorCode?String(event.errorCode).slice(0,64):null,
    status_code:Number.isInteger(event.statusCode)?event.statusCode:null,
    created_at:new Date().toISOString(),
    at:Date.now(),
  };
  snapshots.delete(id);
  snapshots.set(id,state);
  if(snapshots.size>MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
  return true;
}
export async function record(event) { observe(event); }
export async function flushAudit() { return 0; }
export async function cleanupAudit() { const count=snapshots.size;removeExpired();return count-snapshots.size; }
export function startAudit() { /* sem polling, timers ou escrita em disco */ }
export async function stopAudit() { /* sem fila persistente */ }
export function auditQueueStats() { return {queued:0,dropped:0,mode:'memory-current',size:snapshots.size}; }
export function latestForActivation(activationId) {
  const row=snapshots.get(activationId);
  if(!row)return [];
  if(Date.now()-row.at>SNAPSHOT_TTL_MS){snapshots.delete(activationId);return [];}
  return [{source:row.source,state:row.state,error_code:row.error_code,
    status_code:row.status_code,created_at:row.created_at}];
}
export function liveQualitySnapshot() { return null; }
export function connectionObserver(ctx,_req,_selectedOrigin,_providerId) {
  const activationId=ctx?.activation?.id || ctx?.activationId;
  return detail=>observe({activationId,source:'relay',state:detail?.state,
    statusCode:detail?.statusCode,errorCode:detail?.errorCode});
}
export async function readAudit(id, partnerId) {
  const owner=await ownership(id);
  if(!canRead(owner,partnerId))throw notFound('Dispositivo');
  const latest=latestForActivation(id);
  return {events:[],nextBefore:null,latest,playbackFresh:latest.some(e=>e.source==='tv'&&e.state==='playing'),
    serverTime:new Date().toISOString(),retentionDays:0,storage:'memory-current'};
}
