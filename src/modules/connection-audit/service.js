// Histórico e snapshots de conexão removidos intencionalmente.
// Presença online e saúde dos servidores permanecem em seus módulos próprios.
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
// Compatibilidade com clientes antigos: aceitar telemetria, sem reter eventos.
export function observe(_event) { return true; }
export async function record(_event) { return; }
export async function flushAudit() { return 0; }
export async function cleanupAudit() { return 0; }
export function startAudit() { /* sem tarefas periódicas */ }
export async function stopAudit() { /* sem fila a descarregar */ }
export function auditQueueStats() { return {queued:0,dropped:0,mode:'disabled'}; }
export function latestForActivation(_activationId) { return []; }
export function liveQualitySnapshot() { return null; }
export function connectionObserver(_ctx,_req,_selectedOrigin,_providerId) {
  return (_detail) => {}; // callbacks antigos do relay permanecem compatíveis
}
export async function readAudit(id, partnerId) {
  const owner = await ownership(id);
  if (!canRead(owner,partnerId)) throw notFound('Dispositivo');
  return { events:[], nextBefore:null, latest:[], playbackFresh:false,
    serverTime:new Date().toISOString(), retentionDays:0, storage:'disabled' };
}
