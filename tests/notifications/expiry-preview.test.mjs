import test from 'node:test';
import assert from 'node:assert/strict';
import { previewExpiryNotice, resolveNotice, DEFAULT_EXPIRY_SETTINGS } from '../../src/modules/clients/expiry-notice.rules.js';
const now = new Date('2026-11-12T12:00:00Z');

test('teste individual simula 3 dias mesmo com a regra global desativada', () => {
  const out = previewExpiryNotice({ ...DEFAULT_EXPIRY_SETTINGS, enabled: false }, 3, now);
  assert.equal(out.text, 'Seu serviço vence em 3 dias.');
  assert.equal(out.simulated, true);
  assert.equal(out.daysLeft, 3);
});
test('texto singular e vencimento hoje', () => {
  assert.equal(previewExpiryNotice({ messageMode: 'channels' }, 1, now).text, 'Seus canais vencem em 1 dia.');
  assert.equal(previewExpiryNotice({ messageMode: 'channels' }, 0, now).text, 'Seus canais vencem hoje.');
});
test('usa modelos personalizados da revenda sem sobrescrevê-los', () => {
  const settings={ messageMode: 'custom', customBefore: 'Seus canais vencem em {prazo} ({data}).', customToday: 'Atenção! Vence hoje!' };
  assert.equal(previewExpiryNotice(settings, 3, now).text, 'Seus canais vencem em 3 dias (15/11/2026).');
  assert.equal(previewExpiryNotice(settings, 0, now).text, 'Atenção! Vence hoje!');
});
test('não depende do vencimento real e não habilita regra em memória', () => {
  const before={ ...DEFAULT_EXPIRY_SETTINGS, enabled: false, daysBefore: 2 };
  previewExpiryNotice(before, 3, now);
  assert.equal(before.enabled, false);
  assert.equal(before.daysBefore, 2);
  assert.equal(resolveNotice(before, '2026-11-15', now), null);
});
test('rejeita simulações inválidas sem ler dados reais', () => {
  for (const d of [-1, 31, 1.5, NaN, '3', null]) assert.equal(previewExpiryNotice({}, d, now), null);
});
test('não mostra texto customizado com template malformado', () => {
  assert.equal(previewExpiryNotice({ messageMode: 'custom', customBefore: '<script>', customToday: 'Ok' }, 3, now), null);
});
