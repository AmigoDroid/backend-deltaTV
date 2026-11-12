import { daysUntil } from './client.rules.js';

export const DEFAULT_EXPIRY_SETTINGS = Object.freeze({
  enabled: false, daysBefore: 3, messageMode: 'service',
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
