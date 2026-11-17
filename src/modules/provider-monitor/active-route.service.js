/** Apenas a escolha ATUAL de DNS por ativação, não um histórico de eventos da TV.
 * Uma linha por ativação. Necessária para failover iniciado pelo servidor em PM2 cluster.
 * Não armazena telemetria, dados de reprodução, URL, credenciais ou logs.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';

export async function rememberSelectedProvider(activationId, providerId) {
  if (!activationId || !providerId) return;
  await sequelize.query(`INSERT INTO device_provider_routes (activation_id,provider_id,updated_at)
    VALUES (:activationId,:providerId,now())
    ON CONFLICT (activation_id) DO UPDATE SET
      provider_id=EXCLUDED.provider_id,updated_at=EXCLUDED.updated_at
    WHERE device_provider_routes.provider_id IS DISTINCT FROM EXCLUDED.provider_id`,
  { replacements:{activationId,providerId} });
}

export async function selectedProviderForDevice(activationId) {
  const [row] = await sequelize.query(`SELECT provider_id AS "providerId"
    FROM device_provider_routes WHERE activation_id=:activationId LIMIT 1`,
  { replacements:{activationId},type:QueryTypes.SELECT });
  return row?.providerId ?? null;
}

/** Quando um DNS cai, avisa TVs com rota atual apontando para ele.
 * A TV recolhe o comando 'refresh-catalog' via WSS/poll HTTPS; o resolver seleciona
 * alternativa saudável no pedido seguinte. Limite fixo por rodada, sem histórico de TV.
 */
export async function queueRefreshForDownProvider(providerId, limit=100) {
  const { randomUUID } = await import('node:crypto');
  const { broadcastDeviceHint } = await import('../../realtime/device-channel.js');
  // Seleção dos candidatos evita emitir comandos repetidos enquanto a TV não recolhe.
  const rows = await sequelize.query(`SELECT r.activation_id AS "activationId", a.device_id AS "deviceId"
    FROM device_provider_routes r JOIN activations a ON a.id=r.activation_id
    WHERE r.provider_id=:providerId AND a.status <> 'revoked'
      AND EXISTS (SELECT 1 FROM device_sessions s WHERE s.activation_id=a.id
         AND s.revoked_at IS NULL AND s.expires_at>now())
      AND NOT EXISTS (SELECT 1 FROM device_remote_commands c
         WHERE c.activation_id=r.activation_id AND c.type='refresh-catalog'
           AND c.created_at>now()-interval '3 minutes')
    ORDER BY r.updated_at ASC LIMIT :limit`,
    {replacements:{providerId,limit},type:QueryTypes.SELECT});
  // Por lote pequeno. Failover de uma TV não pode causar avalanche de CPU no PostgreSQL.
  let queued=0;
  for(const r of rows){
    const [result] = await sequelize.query(`INSERT INTO device_remote_commands
      (id,activation_id,device_id,type,status,actor_type,actor_id,expires_at,created_at,updated_at)
      VALUES (:id,:aid,:did,'refresh-catalog','pending','system','provider-monitor',now()+interval '3 minutes',now(),now())
      RETURNING id`,{replacements:{id:randomUUID(),aid:r.activationId,did:r.deviceId},type:QueryTypes.SELECT});
    if(result){queued++;broadcastDeviceHint({topic:'remote-command',activationId:r.activationId});}
  }
  return queued;
}
