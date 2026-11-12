import { daysUntil, todaySP } from './client.rules.js';

export const DEFAULT_EXPIRY_SETTINGS = Object.freeze({
  enabled: false, daysBefore: 3, messageMode: 'service', deliveryMode: 'daily',
  customBefore: 'Seu acesso vence em {prazo}.', customToday: 'Seu acesso vence hoje.',
});
const PLACEHOLDER = /\{([^{}]+)\}/g;
export function validTemplate(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= 180 &&
    !/[\x00-\x1f<>]/.test(text) &&
    [...text.matchAll(PLACEHOLDER)].every(m => ['prazo','dias','data'].includes(m[1])) &&
    !text.replace(PLACEHOLDER, '').includes('{') && !text.replace(PLACEHOLDER, '').includes('}');
}
export function resolveNotice(settings, dueDate, now = new Date()) {
  const cfg = { ...DEFAULT_EXPIRY_SETTINGS, ...settings };
  const days = daysUntil(dueDate, now);
  if (!cfg.enabled || days === null || days < 0 || days > cfg.daysBefore) return null;
  let message;
  if (cfg.messageMode === 'custom') {
    const template = days === 0 ? cfg.customToday : cfg.customBefore;
    if (!validTemplate(template)) return null;
    message = template.replace(PLACEHOLDER, (_, key) => ({
      dias: String(days), prazo: `${days} ${days === 1 ? 'dia' : 'dias'}`,
      data: String(dueDate).split('-').reverse().join('/'),
    })[key]);
  } else {
    const channels = cfg.messageMode === 'channels';
    message = days === 0
      ? (channels ? 'Seus canais vencem hoje.' : 'Seu serviço vence hoje.')
      : (channels ? `Seus canais vencem em ${days} ${days === 1 ? 'dia' : 'dias'}.`
        : `Seu serviço vence em ${days} ${days === 1 ? 'dia' : 'dias'}.`);
  }
  return { title: 'Aviso de vencimento', message, daysLeft: days, dueDate };
}

/** Prévia de uso exclusivo do comando de teste. Não altera o vencimento real,
 * nem habilita notificações para clientes da revenda. Usa o template atual.
 */
export function previewExpiryNotice(settings, daysLeft, now = new Date()) {
  if (!Number.isInteger(daysLeft) || daysLeft < 0 || daysLeft > 30) return null;
  const today = todaySP(now);
  const due = new Date(`${today}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + daysLeft);
  const dueDate = due.toISOString().slice(0, 10);
  const notice = resolveNotice({ ...settings, enabled: true, daysBefore: 30 }, dueDate, now);
  return notice && notice.message.length <= 180 ? { title: 'TESTE - Aviso de vencimento', text: notice.message, simulated: true, daysLeft } : null;
}

/** Deduplica avisos por dia ou abertura; o identificador de abertura e aleatório
 * e enviado pela app atualizada. Em clientes antigos, mantém regra diária.
 * Nunca incluir MAC ou credenciais na chave.
 */
export function makeExpiryNoticeKey({ activationId, dueDate, daysLeft, deliveryMode = 'daily', launchId }) {
  const base = `${activationId}:${dueDate}:${daysLeft}`;
  if (deliveryMode === 'every_open' && typeof launchId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(launchId)) {
    return `open:${base}:${launchId.toLowerCase()}`;
  }
  return `daily:${base}`;
}
