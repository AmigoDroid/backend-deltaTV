/** Ficha única OPERACIONAL: usa as fontes atuais, não duplica cadastros nem grava telemetria.
 * Nenhuma senha, URL Xtream, token, hash de licença ou IP histórico é devolvido.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';
import { Activation, Device, Partner, PartnerProvider, ProviderHealth, ResellerClient } from '../../db/models/index.js';
import { notFound } from '../../shared/errors.js';
import { checkActivation } from '../access/access.service.js';
import { presenceOf } from '../devices/presence.js';
import { liveForDevice } from '../../realtime/live-snapshot.js';
import { assertControlScope } from '../../realtime/remote-control.service.js';
import { assessSupport } from './diagnostic.rules.js';
import { selectClientActivations } from './support.policy.js';

const select = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const dateValue = v => v ? new Date(v).toISOString() : null;

/** Acesso por ativação: operador do parceiro só consulta uma ativação de sua alçada.
 * O assertControlScope já usa o dono da licença, quando aplicável, além do parceiro.
 */
export async function supportForActivation(activationId, partnerId = null, commercial = null) {
  await assertControlScope(activationId, partnerId);
  const activation = await Activation.findByPk(activationId, {
    attributes: ['id','deviceId','partnerId','providerId','mac','status','activatedAt','playlistName'],
  });
  if (!activation) throw notFound('Ativação');

  // Leituras limitadas. Não testa uma URL IPTV arbitrária — evita SSRF e tráfego no suporte.
  const [device, provider, { decision }, events] = await Promise.all([
    Device.findByPk(activation.deviceId, { attributes: ['id','mac','platform','lastSeenAt','appVersion'] }),
    activation.providerId ? PartnerProvider.findByPk(activation.providerId, { attributes: ['id','name','status'] }) : Promise.resolve(null),
    checkActivation(activation.id),
    select(`SELECT source,state,error_code AS "errorCode",status_code AS "statusCode",created_at AS "createdAt"
      FROM device_connection_latest WHERE activation_id=:id AND created_at>now()-interval '15 minutes'
      ORDER BY CASE WHEN source='tv' THEN 0 ELSE 1 END,created_at DESC LIMIT 3`, { id: activationId }),
  ]);
  const providerHealth = provider ? await ProviderHealth.findOne({
    where: { providerId: provider.id }, attributes: ['state','latencyMs','lastCheckedAt','lastGoodAt'],
  }) : null;
  const recent = events.find(e => e.source === 'tv') || null;
  const freshEvent = recent && Date.now() - new Date(recent.createdAt).getTime() < 5 * 60_000;
  const playback = liveForDevice(activation.id);
  const presence = presenceOf(activation.deviceId, device?.lastSeenAt);
  const connection = { online: !!(presence.online || playback.online),
    lastSeenAt: playback.online ? playback.lastSeenAt : dateValue(presence.lastSeenAt),
    telemetryAvailable: !!playback.online, transport: null };
  const health = provider ? { id: provider.id, name: provider.name, status: provider.status,
    state: providerHealth?.state || 'unknown', latencyMs: providerHealth?.latencyMs ?? null,
    checkedAt: dateValue(providerHealth?.lastCheckedAt),
    fresh: !!providerHealth?.lastCheckedAt && Date.now() - new Date(providerHealth.lastCheckedAt).getTime() < 10*60_000 } : null;
  const access = { allowed: !!decision.allowed, code: decision.code,
    expiresAt: dateValue(decision.expiresAt) };
  const diagnosis = assessSupport({ access, connection, playback: playback.playback,
    provider: health, commercial, recentEvent: recent ? { ...recent, fresh: !!freshEvent } : null });
  return {
    checkedAt: new Date().toISOString(),
    activation: { id: activation.id, name: activation.playlistName || 'Lista',
      status: activation.status, activatedAt: dateValue(activation.activatedAt),
      deviceId: activation.deviceId, partnerId: activation.partnerId },
    device: { mac: device?.mac?.trim() || activation.mac?.trim() || null,
      platform: device?.platform || 'unknown', appVersion: device?.appVersion || null, ...connection },
    access, provider: health,
    live: { ip: playback.online ? playback.ip || null : null,
      playback: playback.online ? playback.playback : null,
      appActiveSeconds: playback.online ? playback.appActiveSeconds : null,
      usage: playback.online ? playback.usage : null,
      coverage: 'Estado efêmero no processo API; não há histórico permanente de títulos/IPs.' },
    recentEvent: recent ? { source: recent.source, state: recent.state,
      errorCode: recent.errorCode, statusCode: recent.statusCode, at: recent.createdAt } : null,
    diagnosis,
  };
}

/** Ficha comercial única, isolada por parceiro, com até 20 vínculos de ativação. */
export async function supportForClient(clientId, partnerId = null) {
  const where = { id: clientId, ...(partnerId ? { partnerId } : {}) };
  const client = await ResellerClient.findOne({ where,
    attributes: ['id','partnerId','deviceId','mac','name','phone','dueDate','priceCents','notes'] });
  if (!client) throw notFound('Cliente');
  const [partner, activations, dateRows] = await Promise.all([
    Partner.findByPk(client.partnerId, { attributes: ['id','name'] }),
    Activation.findAll({
      where: { partnerId: client.partnerId, mac: client.mac },
      attributes: ['id','partnerId','deviceId','mac','status','playlistName','activatedAt'],
      order: [['activatedAt','DESC']], limit: 20,
    }),
    select(`SELECT (:dueDate)::date - (now() AT TIME ZONE 'America/Sao_Paulo')::date AS "daysLeft"`,
      { dueDate: client.dueDate || null }),
  ]);
  // Preferir ativação utilizável; nunca inventar um vínculo quando existem MACs diferentes.
  const { matches: matched, ambiguous } = selectClientActivations(client, activations);
  const current = matched.find(a => a.status === 'active') || matched.find(a => a.status === 'blocked') || matched[0] || null;
  const daysLeft = dateRows[0]?.daysLeft == null ? null : Number(dateRows[0].daysLeft);
  const commercial = { dueDate: client.dueDate || null, daysLeft };
  const selected = current ? await supportForActivation(current.id, client.partnerId, commercial) : null;
  return {
    checkedAt: new Date().toISOString(),
    client: { id: client.id, name: client.name, mac: client.mac.trim(),
      partnerId: client.partnerId, partnerName: partner?.name || null,
      phone: client.phone || null, dueDate: commercial.dueDate, daysLeft,
      priceCents: client.priceCents ?? null, deviceId: client.deviceId || null },
    ambiguity: ambiguous ? 'Existem vínculos de dispositivos incompatíveis com esta ficha. Revise o MAC e o dispositivo canônico antes de associá-los.' : null,
    lists: matched.map(a => ({ id: a.id, name: a.playlistName || 'Lista',
      status: a.status, deviceId: a.deviceId, activatedAt: dateValue(a.activatedAt) })),
    selected,
    ...(current ? {} : { diagnosis: ambiguous ? { status: 'warning', headline: 'Vínculo de dispositivo ambíguo',
      nextAction: 'Conferir os dispositivos vinculados a este MAC antes de executar ações remotas.', findings: [] } :
      { status: 'unknown', headline: 'Cliente sem ativação correspondente', nextAction: 'Configure a lista na TV ou verifique o MAC cadastrado.', findings: [] } }),
  };
}
