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

/** Um sinal por rede quando um DNS cai (sem credenciais e sem fila SQL de 3.000 comandos).
 * A TV confere o providerId contra a origem selecionada e busca a nova rota
 * na API autenticada. WSS é imediato; Roku antigo usa o long-poll HTTPS existente.
 */
export async function queueRefreshForDownProvider(providerId) {
  const [provider] = await sequelize.query(`SELECT partner_id AS "partnerId" FROM partner_providers
    WHERE id=:providerId AND status='active' AND deleted_at IS NULL LIMIT 1`,
    { replacements:{providerId}, type:QueryTypes.SELECT });
  if (!provider?.partnerId) return 0;
  const { broadcastDeviceHint } = await import('../../realtime/device-channel.js');
  broadcastDeviceHint({topic:'dns-failover',partnerId:provider.partnerId,providerId});
  return 1;
}
