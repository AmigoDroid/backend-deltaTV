import { sequelize } from '../../db/sequelize.js';
import { QueryTypes } from 'sequelize';
import { audit } from '../../shared/audit.js';
import { broadcastDeviceHint } from '../../realtime/device-channel.js';
import { DEFAULT_EXPIRY_SETTINGS, resolveNotice, makeExpiryNoticeKey } from './expiry-notice.rules.js';

export async function getSettings(partnerId) {
  const [row] = await sequelize.query(`SELECT enabled, days_before AS "daysBefore", message_mode AS "messageMode",
    custom_before AS "customBefore", custom_today AS "customToday", delivery_mode AS "deliveryMode"
    FROM reseller_expiry_notice_settings WHERE partner_id=:partnerId`,
    { replacements: { partnerId }, type: QueryTypes.SELECT });
  return { ...DEFAULT_EXPIRY_SETTINGS, ...(row || {}),
    customBefore: row?.customBefore ?? DEFAULT_EXPIRY_SETTINGS.customBefore,
    customToday: row?.customToday ?? DEFAULT_EXPIRY_SETTINGS.customToday };
}
export async function setSettings(partnerId, settings, actor) {
  // Um portal antigo pode não enviar deliveryMode: preservar a regra já salva.
  const previous = settings.deliveryMode === undefined ? await getSettings(partnerId) : null;
  const cfg = { ...DEFAULT_EXPIRY_SETTINGS, ...(previous || {}), ...settings };
  await sequelize.query(`INSERT INTO reseller_expiry_notice_settings
    (partner_id,enabled,days_before,message_mode,custom_before,custom_today,delivery_mode)
    VALUES (:partnerId,:enabled,:daysBefore,:messageMode,:customBefore,:customToday,:deliveryMode)
    ON CONFLICT (partner_id) DO UPDATE SET
      enabled=EXCLUDED.enabled,days_before=EXCLUDED.days_before,message_mode=EXCLUDED.message_mode,
      custom_before=EXCLUDED.custom_before,custom_today=EXCLUDED.custom_today,
      delivery_mode=EXCLUDED.delivery_mode,updated_at=now()`,
    { replacements: { partnerId, ...cfg } });
  await audit({ actor, action: 'reseller.expiry_notice.update', entityType: 'partner', entityId: partnerId,
    metadata: { enabled: cfg.enabled, daysBefore: cfg.daysBefore, messageMode: cfg.messageMode, deliveryMode: cfg.deliveryMode } });
  // Aviso restrito às ativações da revenda, distribuído ao longo de segundos pelo cliente.
  broadcastDeviceHint({ topic: 'expiry-notice', partnerId });
  return cfg;
}
export async function noticeForActivation(activationId, launchId = undefined) {
  // O ID veio da sessão autenticada. Nunca aceitar MAC/partnerId do aparelho.
  const [row] = await sequelize.query(`SELECT a.id, a.partner_id AS "partnerId", to_char(c.due_date, 'YYYY-MM-DD') AS "dueDate",
      s.enabled,s.days_before AS "daysBefore",s.message_mode AS "messageMode",
      s.custom_before AS "customBefore",s.custom_today AS "customToday",
      s.delivery_mode AS "deliveryMode"
    FROM activations a
    LEFT JOIN reseller_clients c ON c.partner_id=a.partner_id AND c.mac=a.mac
    LEFT JOIN reseller_expiry_notice_settings s ON s.partner_id=a.partner_id
    WHERE a.id=:activationId AND a.status='active' LIMIT 1`,
    { replacements: { activationId }, type: QueryTypes.SELECT });
  if (!row || !row.enabled || !row.dueDate) return { visible: false };
  const dueDate = typeof row.dueDate === 'string' ? row.dueDate : row.dueDate.toISOString().slice(0,10);
  const notice = resolveNotice(row, dueDate);
  if (!notice) return { visible: false };
  // Por padrão mostra uma vez por dia. Quando o app novo informa a abertura,
  // "every_open" mostra outra vez no próximo launch, nunca em uma reconexão WSS.
  const noticeKey = makeExpiryNoticeKey({ activationId, dueDate, daysLeft: notice.daysLeft,
    deliveryMode: row.deliveryMode, launchId });
  return { visible: true, ...notice, noticeKey };
}
export function broadcastExpiryForClient(partnerId, mac) {
  // 1 único GET à DB na mudança de cadastro; sem varrer todas as TVs.
  void sequelize.query(`SELECT id FROM activations WHERE partner_id=:partnerId AND mac=:mac AND status <> 'revoked'`,
    { replacements: { partnerId, mac }, type: QueryTypes.SELECT })
    .then(rows => { for (const a of rows) broadcastDeviceHint({ topic: 'expiry-notice', activationId: a.id, partnerId }); })
    .catch(err => console.warn('[expiry-notice] notificação indisponível:', err.message));
}
