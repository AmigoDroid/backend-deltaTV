/** Mensagens persistentes para TV; WSS/notificação serve só para acordar o aparelho.
 * Todo acesso a destinatários vem do escopo autenticado, jamais do browser.
 */
import { createHash, randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { AppError } from '../../shared/errors.js';
import { broadcastDeviceHint } from '../../realtime/device-channel.js';
import { canonicalMessagePayload, uniqueDeviceIds } from './message.policy.js';

const query = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
const uuidList = ids => ids.length ? 'AND e.id IN (:deviceIds)' : '';
const scopeSql = partnerId => partnerId ? `AND (a.partner_id = :partnerId
  OR grant_license.owner_partner_id = :partnerId OR main_license.owner_partner_id = :partnerId)` : '';
const sourceSql = partnerId => `WITH eligible AS (
    SELECT DISTINCT ON (a.device_id)
      a.device_id AS id, a.id AS activation_id, d.mac,
      COALESCE(NULLIF(a.playlist_name,''), NULLIF(d.mac,''), 'TV') AS name
    FROM activations a
    JOIN devices d ON d.id = a.device_id
    LEFT JOIN licenses grant_license ON grant_license.id = a.granted_license_id
    LEFT JOIN licenses main_license ON main_license.id = a.license_id
    WHERE a.status = 'active' AND a.device_id IS NOT NULL
    ${scopeSql(partnerId)}
    ORDER BY a.device_id, a.activated_at DESC, a.id DESC
  )`;
const params = (partnerId, extra = {}) => ({ partnerId, ...extra });
const searchFilter = `(:q = '' OR POSITION(LOWER(:q) IN LOWER(COALESCE(e.name,''))) > 0
  OR POSITION(LOWER(:q) IN LOWER(COALESCE(e.mac,''))) > 0
  OR POSITION(REPLACE(LOWER(:q),':','') IN REPLACE(LOWER(COALESCE(e.mac,'')),':','')) > 0)`;

export async function listRecipients({ partnerId, q = '', page = 1 }) {
  const [rows, count] = await Promise.all([
    query(`${sourceSql(partnerId)} SELECT e.id, e.mac, e.name FROM eligible e WHERE ${searchFilter}
      ORDER BY e.name, e.id LIMIT 20 OFFSET :offset`, params(partnerId, { q, offset: (page - 1) * 20 })),
    query(`${sourceSql(partnerId)} SELECT count(*)::int AS total FROM eligible e WHERE ${searchFilter}`,
      params(partnerId, { q })),
  ]);
  return { data: rows, total: count[0]?.total || 0, page };
}

async function recipientsInScope({ partnerId, audience, deviceIds }, transaction) {
  const ids = audience === 'selected' ? uniqueDeviceIds(deviceIds) : [];
  if (audience === 'selected' && !ids.length) throw new AppError(400,'NO_RECIPIENTS','Selecione pelo menos uma TV.');
  const [r] = await query(`${sourceSql(partnerId)} SELECT count(*)::int AS total FROM eligible e
    WHERE 1=1 ${uuidList(ids)}`, params(partnerId, { deviceIds: ids }), transaction);
  const total = r?.total || 0;
  if (audience === 'selected' && total !== ids.length)
    throw new AppError(404,'TV_NOT_ACCESSIBLE','Uma ou mais TVs não pertencem à sua carteira ou não estão ativas.');
  if (!total) throw new AppError(400,'NO_RECIPIENTS','Nenhuma TV elegível para mensagens.');
  return total;
}
export async function previewMessage({ partnerId, audience, deviceIds }) {
  return { total: await recipientsInScope({ partnerId, audience, deviceIds }) };
}

export async function listCampaigns({ userId, page }) {
  const data = await query(`SELECT c.id,c.title,c.message,c.created_at,c.expires_at,c.cancelled_at,
    count(d.id)::int AS total,count(d.read_at)::int AS read
    FROM (SELECT id,title,message,created_at,expires_at,cancelled_at
      FROM tv_message_campaigns WHERE sender_user_id = :userId
      ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET :offset) c
    LEFT JOIN tv_message_deliveries d ON d.campaign_id=c.id
    GROUP BY c.id,c.title,c.message,c.created_at,c.expires_at,c.cancelled_at
    ORDER BY c.created_at DESC,c.id DESC`,
    { userId, offset: (page - 1) * 20 });
  return { data, page };
}
export async function sendMessage({ userId, partnerId, audience, deviceIds, title, message, expiresInDays, requestId }) {
  const ids = audience === 'selected' ? uniqueDeviceIds(deviceIds) : [];
  const requestHash = createHash('sha256').update(canonicalMessagePayload({ audience, deviceIds: ids,
    title, message, expiresInDays })).digest('hex');
  // Não altera o vencimento ou destinatários quando uma requisição é repetida.
  const result = await sequelize.transaction(async transaction => {
    const [existing] = await query(`SELECT id,request_hash AS "requestHash" FROM tv_message_campaigns
      WHERE sender_user_id = :userId AND request_id = :requestId`, { userId, requestId }, transaction);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AppError(409,'IDEMPOTENCY_CONFLICT','Essa chave já foi usada para outro envio.');
      const [count] = await query(`SELECT count(*)::int AS total FROM tv_message_deliveries
        WHERE campaign_id = :id`, { id: existing.id }, transaction);
      return { id: existing.id, total: count.total, repeated: true };
    }
    const total = await recipientsInScope({ partnerId, audience, deviceIds: ids }, transaction);
    const campaignId = randomUUID();
    // Conflito idempotente, inclusive em duas requisições concorrentes.
    const inserted = await query(`INSERT INTO tv_message_campaigns
      (id,sender_user_id,sender_partner_id,request_id,request_hash,audience,title,message,expires_at)
      VALUES (:id,:userId,:partnerId,:requestId,:requestHash,:audience,:title,:message,
        now() + (:days * interval '1 day'))
      ON CONFLICT (sender_user_id,request_id) DO NOTHING RETURNING id`,
      { id: campaignId, userId, partnerId, requestId, requestHash, audience, title, message, days: expiresInDays }, transaction);
    if (!inserted.length) {
      const [prior] = await query(`SELECT id,request_hash AS "requestHash" FROM tv_message_campaigns
        WHERE sender_user_id = :userId AND request_id = :requestId`, { userId, requestId }, transaction);
      if (!prior || prior.requestHash !== requestHash) throw new AppError(409,'IDEMPOTENCY_CONFLICT','Chave de envio já utilizada.');
      const [count] = await query(`SELECT count(*)::int AS total FROM tv_message_deliveries WHERE campaign_id=:id`,
        { id: prior.id }, transaction);
      return { id: prior.id, total: count.total, repeated: true };
    }
    // Uma linha por TV, mesmo quando existem várias listas/ativações no mesmo aparelho.
    // Inserção por SELECT evita carregar milhares de IDs em memória.
    await query(`${sourceSql(partnerId)} INSERT INTO tv_message_deliveries
      (id,campaign_id,device_id,activation_id)
      SELECT gen_random_uuid(),:campaignId,e.id,e.activation_id FROM eligible e
      WHERE 1=1 ${uuidList(ids)} ON CONFLICT (campaign_id,device_id) DO NOTHING`,
      params(partnerId, { campaignId, deviceIds: ids }), transaction);
    const [actual] = await query(`SELECT count(*)::int AS total FROM tv_message_deliveries WHERE campaign_id=:id`,
      { id: campaignId }, transaction);
    if (!actual.total) throw new AppError(409,'NO_RECIPIENTS','Nenhuma TV elegível no momento do envio.');
    if (audience === 'selected' && actual.total !== ids.length)
      throw new AppError(409,'RECIPIENT_CHANGED','A carteira mudou durante o envio. Confira novamente.');
    return { id: campaignId, total: actual.total, repeated: false };
  });
  if (!result.repeated) {
    // WSS/HTTPS long-poll recebem apenas um sinal de novidade. Os textos são
    // buscados pela TV em endpoint autenticado. Limite de fanout no processo;
    // demais aparelhos recebem ao consultar a API (compatibilidade com Roku legado).
    const targets = await query(`SELECT activation_id FROM tv_message_deliveries
      WHERE campaign_id=:id ORDER BY activation_id LIMIT 2000`, { id: result.id });
    for (const target of targets) broadcastDeviceHint({ topic: 'tv-messages', activationId: target.activation_id });
  }
  return { campaignId: result.id, total: result.total, repeated: result.repeated };
}
export async function cancelMessage({ userId, id }) {
  const updated = await query(`UPDATE tv_message_campaigns SET cancelled_at = COALESCE(cancelled_at,now())
    WHERE id = :id AND sender_user_id = :userId RETURNING id`, { id, userId });
  if (!updated.length) throw new AppError(404,'NOT_FOUND','Comunicado não encontrado.');
  // Um cancelamento não apaga as confirmações de leitura já registradas.
  const targets = await query(`SELECT activation_id FROM tv_message_deliveries
    WHERE campaign_id=:id ORDER BY activation_id LIMIT 2000`, { id });
  for (const target of targets) broadcastDeviceHint({ topic:'tv-messages', activationId:target.activation_id });
  return { ok: true };
}
export async function pendingForDevice(activationId) {
  const rows = await query(`SELECT d.id AS "deliveryId", c.id AS "campaignId", c.title,c.message,
    c.expires_at AS "expiresAt",c.created_at AS "createdAt"
    FROM tv_message_deliveries d JOIN tv_message_campaigns c ON c.id=d.campaign_id
    JOIN activations a ON a.id=d.activation_id AND a.status='active'
    WHERE d.activation_id=:activationId AND d.read_at IS NULL
      AND c.cancelled_at IS NULL AND c.expires_at>now()
    ORDER BY c.created_at ASC,d.id ASC LIMIT 20`, { activationId });
  if (rows.length) await query(`UPDATE tv_message_deliveries SET delivered_at=COALESCE(delivered_at,now())
    WHERE activation_id=:activationId AND id IN (:ids) RETURNING id`,
    { activationId, ids: rows.map(r=>r.deliveryId) });
  return { data: rows };
}
export async function markRead({ activationId, deliveryId }) {
  // O token do aparelho define a ativação; um UUID de outra TV nunca autoriza ler sua mensagem.
  const [row] = await query(`UPDATE tv_message_deliveries d
    SET read_at=COALESCE(d.read_at,now()),delivered_at=COALESCE(d.delivered_at,now())
    FROM tv_message_campaigns c, activations a
    WHERE d.id=:deliveryId AND d.activation_id=:activationId AND c.id=d.campaign_id
      AND a.id=d.activation_id AND a.status='active'
      AND c.cancelled_at IS NULL AND c.expires_at>now()
    RETURNING d.id,d.read_at AS "readAt"`, { activationId, deliveryId });
  if (!row) throw new AppError(404,'NOT_FOUND','Mensagem indisponível para esta TV.');
  return { ok:true, readAt:row.readAt };
}
