/** Solicitação de mudança de origem pela TV: autorização pela sessão já validada.
 * Não força um provedor globalmente para baixo e não converte redirect em proxy.
 * Um único pedido a cada 120 s por ativação, TTL 10 min, mantendo estado no Postgres
 * para consistência no PM2 cluster. O resolver verifica a alternativa e autenticação.
 */
import { QueryTypes, Op } from 'sequelize';
import { Activation, PartnerCode, ProviderHealth } from '../../db/models/index.js';
import { serversForCode } from './code-pool.service.js';
import { getServicePlan } from '../service-plans/plan.service.js';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../shared/errors.js';
import { checkActivation } from '../access/access.service.js';
import { xtreamCredentialsOf } from '../xtream/xtream.service.js';

export async function requestDeviceFailover(activationId) {
  if (process.env.PROVIDER_MONITOR_ENABLED !== 'true' || process.env.PROVIDER_SMART_RESOLVER === 'false')
    throw new AppError(409,'FAILOVER_DISABLED','Balanceamento automático não habilitado.');
  const { decision } = await checkActivation(activationId);
  if (!decision.allowed) throw new AppError(403,'ACTIVATION_BLOCKED','Ativação sem acesso.');
  const activation = await Activation.findByPk(activationId,{attributes:['id','partnerCodeId','partnerId','playlistUrlEnc'],raw:true});
  if (!activation?.partnerCodeId || activation.playlistUrlEnc) throw new AppError(409,'FAILOVER_NOT_SUPPORTED','Lista sem pool de servidores da parceria.');
  const code = await PartnerCode.findByPk(activation.partnerCodeId,{attributes:['id','partnerId','providerId','status'],raw:true});
  const plan = await getServicePlan(activation.partnerId);
  if (!code || code.partnerId !== activation.partnerId || code.status !== 'active' || !plan.features.autoFailover)
    throw new AppError(409,'FAILOVER_NOT_SUPPORTED','A parceria não possui failover habilitado.');
  const [selected] = await sequelize.query(`SELECT s.provider_id AS id
    FROM device_connection_latest s
    JOIN partner_providers p ON p.id=s.provider_id
    JOIN activations a ON a.id=s.activation_id AND a.partner_id=p.partner_id
    WHERE s.activation_id=:aid AND s.source='selection'
      AND s.created_at>now()-interval '20 minutes'
    LIMIT 1`,{replacements:{aid:activationId},type:QueryTypes.SELECT});
  if (!selected?.id) throw new AppError(409,'NO_SELECTED_PROVIDER','Ainda não há servidor selecionado na auditoria.');
  // Não desligar nem interromper a TV se não existir alternativa saudável autorizada.
  const pool = await serversForCode(code);
  const others = pool.filter(p=>p.id!==selected.id && p.status==='active');
  if (!others.length) throw new AppError(409,'NO_ALTERNATIVE','Não há servidor alternativo autorizado.');
  const healthy = await ProviderHealth.findAll({where:{providerId:{[Op.in]:others.map(p=>p.id)},state:{[Op.in]:['healthy','slow']},lastCheckedAt:{[Op.gt]:new Date(Date.now()-180000)}},attributes:['providerId'],raw:true});
  if (!healthy.length) throw new AppError(409,'NO_HEALTHY_ALTERNATIVE','Nenhuma alternativa saudável confirmada.');
  const [saved] = await sequelize.query(`INSERT INTO device_failover_requests
    (activation_id,avoid_provider_id,requested_at,expires_at)
    VALUES (:aid,:provider,now(),now()+interval '10 minutes')
    ON CONFLICT (activation_id) DO UPDATE
      SET avoid_provider_id=EXCLUDED.avoid_provider_id,
          requested_at=EXCLUDED.requested_at, expires_at=EXCLUDED.expires_at
    WHERE device_failover_requests.requested_at<now()-interval '2 minutes'
    RETURNING activation_id`, {replacements:{aid:activationId,provider:selected.id},type:QueryTypes.SELECT});
  if (!saved) return {ok:true,accepted:false,reason:'cooldown'};
  // Confirma credenciais na alternativa ANTES de interromper o player. Se o teste
  // falhar, desfaz apenas a intenção desta tentativa. Nunca transmite credenciais
  // ao operador ou ao websocket de controle.
  try {
    const active = await Activation.findByPk(activationId);
    const candidate = await xtreamCredentialsOf(active);
    if (candidate.selectedProvider?.id !== selected.id &&
      (candidate.verifiedAlternative || candidate.selectedProvider?.id === active.providerId))
      return {ok:true,accepted:true,reason:'alternative_verified'};
  } catch { /* fallback seguro abaixo */ }
  await sequelize.query(`DELETE FROM device_failover_requests
    WHERE activation_id=:aid AND avoid_provider_id=:provider`,{replacements:{aid:activationId,provider:selected.id}});
  throw new AppError(409,'ALTERNATIVE_UNVERIFIED','Não foi possível autenticar em outra origem; a TV não foi interrompida.');
}
export async function cleanupDeviceFailover() {
  await sequelize.query(`DELETE FROM device_failover_requests WHERE expires_at<now()`);
}
