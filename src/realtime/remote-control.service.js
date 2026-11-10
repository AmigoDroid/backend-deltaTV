/** Central de comandos remotos. A fila e os ACKs ficam no PostgreSQL para sobreviver a reinícios.
 * Não altera as rotas REST nem a validação de licença dos aplicativos anteriores.
 * O controle é permitido somente ao proprietário da ativação; IDs não dão permissão.
 */
import { randomUUID } from 'node:crypto';
import { QueryTypes, Op } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import { Activation, DeviceSession } from '../db/models/index.js';
import { AppError, notFound } from '../shared/errors.js';
import { audit } from '../shared/audit.js';
import { checkActivation } from '../modules/access/access.service.js';
import { ownership, canRead } from '../modules/connection-audit/service.js';
import { broadcastDeviceHint, transportForActivation } from './device-channel.js';

const read = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const commands = new Set(['refresh-catalog', 'switch-list', 'disconnect', 'sync-access', 'ping']);
const resultStatuses = new Set(['executed', 'failed', 'refused']);
const maxMinutes = 3;

export async function assertControlScope(activationId, partnerId = null) {
  const owner = await ownership(activationId);
  if (!owner || !canRead(owner, partnerId)) throw notFound('Ativação');
  return owner;
}

export async function accessibleLists(source, partnerId = null) {
  const entries = await read(`SELECT a.id, a.playlist_name AS name, a.status, a.partner_id,
      COALESCE(g.owner_partner_id,l.owner_partner_id) AS reseller_id
      FROM activations a
      LEFT JOIN licenses g ON g.id=a.granted_license_id
      LEFT JOIN licenses l ON l.id=a.license_id
      WHERE a.device_id=:deviceId AND a.status <> 'revoked'
      ORDER BY a.activated_at DESC LIMIT 30`, { deviceId: source.device_id });
  return entries.filter(x => !partnerId || x.partner_id === partnerId || x.reseller_id === partnerId)
    .map(x => ({ id: x.id, name: x.name || 'Lista', status: x.status }));
}

export async function queueRemoteCommand({ activationId, type, targetActivationId, note, actor, partnerId = null }) {
  if (!commands.has(type)) throw new AppError(422, 'INVALID_COMMAND', 'Comando não reconhecido.');
  const source = await assertControlScope(activationId, partnerId);
  if (type === 'switch-list') {
    if (!targetActivationId) throw new AppError(422, 'TARGET_REQUIRED', 'Selecione a lista de destino.');
    const target = await assertControlScope(targetActivationId, partnerId);
    if (String(target.device_id) !== String(source.device_id)) throw new AppError(422, 'OTHER_DEVICE', 'A lista não pertence a esta TV.');
    const { decision } = await checkActivation(targetActivationId);
    if (!decision.allowed) throw new AppError(409, 'TARGET_NOT_AVAILABLE', 'A lista de destino está bloqueada, expirada ou indisponível.');
  }
  if (type === 'disconnect' && partnerId) {
    // Revendedores e parceiros podem bloquear suas próprias ativações pelos mecanismos existentes,
    // mas não podem revogar remotamente o acesso a todas as listas do mesmo dispositivo.
    throw new AppError(403, 'FORBIDDEN', 'Desconectar a sessão inteira é exclusivo da administração.');
  }
  const id = randomUUID();
  await sequelize.query(`INSERT INTO device_remote_commands
    (id, activation_id, device_id, type, target_activation_id, status, actor_type, actor_id,
      note, expires_at, created_at, updated_at)
    VALUES (:id,:activationId,:deviceId,:type,:target,'pending',:actorType,:actorId,
      :note,now()+interval '3 minutes',now(),now())`, { replacements: {
    id, activationId, deviceId: source.device_id, type, target: type === 'switch-list' ? targetActivationId : null,
    actorType: String(actor?.type || 'admin'), actorId: String(actor?.id || 'unknown'), note: note || null,
  } });
  await audit({ actor, action: 'device.remote.command', entityType: 'activation', entityId: activationId,
    metadata: { commandId: id, type, targetActivationId: type === 'switch-list' ? targetActivationId : null } });
  broadcastDeviceHint({ topic: 'remote-command', activationId });
  // Reentrega o AVISO, não o comando: o ACK continua idempotente no banco.
  // Ajuda quando uma notificação WSS ou long-poll se perde durante reconexão.
  for (const delay of [25000, 60000, 115000]) {
    const t = setTimeout(() => broadcastDeviceHint({ topic: 'remote-command', activationId }), delay);
    t.unref?.();
  }
  return { id, type, status: 'pending', expiresAt: new Date(Date.now() + maxMinutes * 60_000) };
}

// Apenas uma entrega por vez por comando, com lease de 20s para reconexões.
// Um único GET pode conter até 4 comandos; televisão deve deduplicar por ID.
export async function claimRemoteCommands(activationId, transport = 'https') {
  return read(`WITH chosen AS (
      SELECT id FROM device_remote_commands
      WHERE activation_id=:activationId AND expires_at>now()
        AND (status='pending' OR (status='delivered' AND delivered_at<now()-interval '20 seconds'))
      ORDER BY created_at ASC LIMIT 4 FOR UPDATE SKIP LOCKED
    ) UPDATE device_remote_commands d
      SET status='delivered', delivered_at=now(), updated_at=now(), delivery_count=delivery_count+1,
          transport=:transport
      FROM chosen WHERE d.id=chosen.id
      RETURNING d.id, d.type, d.target_activation_id AS "targetActivationId", d.expires_at AS "expiresAt"`,
    { activationId, transport: String(transport).slice(0, 24) });
}

export async function acknowledgeRemoteCommand({ id, activationId, status, errorCode = null }) {
  if (!resultStatuses.has(status)) throw new AppError(422, 'INVALID_ACK', 'Resultado de comando inválido.');
  const [updated] = await read(`UPDATE device_remote_commands SET
      status=:status, error_code=:errorCode, executed_at=now(), updated_at=now()
    WHERE id=:id AND activation_id=:activationId AND expires_at>now()
      AND status='delivered'
    RETURNING id,type,status`, { id, activationId, status, errorCode });
  if (!updated) {
    const [existing] = await read(`SELECT status FROM device_remote_commands WHERE id=:id AND activation_id=:activationId`, { id, activationId });
    if (existing?.status === status) return { ok: true, duplicate: true };
    throw new AppError(409, 'COMMAND_NOT_DELIVERED', 'Comando inexistente, expirado ou não entregue.');
  }
  if (updated.type === 'disconnect' && status === 'executed') {
    // O ACK é enviado ANTES de a TV apagar seus tokens. Impede reuso após o logout.
    await DeviceSession.update({ revokedAt: new Date() }, { where: { activationId, revokedAt: null } });
    broadcastDeviceHint({ topic: 'session', activationId });
  }
  return { ok: true };
}

export async function remoteControlOverview(activationId, partnerId = null) {
  const source = await assertControlScope(activationId, partnerId);
  await sequelize.query(`UPDATE device_remote_commands SET status='expired',updated_at=now()
    WHERE activation_id=:activationId AND status IN ('pending','delivered') AND expires_at<=now()`, { replacements: { activationId } });
  const history = await read(`SELECT id,type,target_activation_id AS "targetActivationId",status,transport,
     error_code AS "errorCode",created_at AS "createdAt",delivered_at AS "deliveredAt",
     executed_at AS "executedAt", expires_at AS "expiresAt"
     FROM device_remote_commands WHERE activation_id=:activationId
     ORDER BY created_at DESC LIMIT 15`, { activationId });
  return { deviceId: source.device_id, activationId, activationStatus: source.status, connection: transportForActivation(activationId),
    lists: await accessibleLists(source, partnerId), history };
}

// Retenção limitada: só apaga registros antigos, sem tocar em comandos pendentes recentes.
export async function pruneRemoteCommands() {
  await sequelize.query(`DELETE FROM device_remote_commands WHERE id IN
    (SELECT id FROM device_remote_commands WHERE created_at < now()-interval '7 days' LIMIT 2000)`);
}
