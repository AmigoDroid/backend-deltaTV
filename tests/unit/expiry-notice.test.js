import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveNotice, DEFAULT_EXPIRY_SETTINGS, validTemplate, makeExpiryNoticeKey } from '../../src/modules/clients/expiry-notice.rules.js';
const NOW = new Date('2026-11-11T13:00:00-03:00');
const cfg = (overrides = {}) => ({ ...DEFAULT_EXPIRY_SETTINGS, enabled: true, daysBefore: 3, ...overrides });
test('Desativado, sem data e fora da janela não exibe', () => {
  assert.equal(resolveNotice(DEFAULT_EXPIRY_SETTINGS, '2026-11-12', NOW), null);
  assert.equal(resolveNotice(cfg(), null, NOW), null);
  assert.equal(resolveNotice(cfg(), '2026-11-15', NOW), null);
  assert.equal(resolveNotice(cfg(), '2026-11-10', NOW), null);
});
test('Texto padrão por serviço, com singular e plural', () => {
  assert.equal(resolveNotice(cfg(), '2026-11-14', NOW).message, 'Seu serviço vence em 3 dias.');
  assert.equal(resolveNotice(cfg(), '2026-11-12', NOW).message, 'Seu serviço vence em 1 dia.');
  assert.equal(resolveNotice(cfg(), '2026-11-11', NOW).message, 'Seu serviço vence hoje.');
});
test('Texto alternativo por canais', () => {
  assert.equal(resolveNotice(cfg({messageMode:'channels'}), '2026-11-11', NOW).message, 'Seus canais vencem hoje.');
});
test('Personalização segura substitui variáveis sem HTML', () => {
  const s=cfg({messageMode:'custom',customBefore:'Seus programas vencem em {prazo}. Data: {data}',customToday:'Hoje é o prazo de {data}'});
  assert.equal(resolveNotice(s,'2026-11-13',NOW).message, 'Seus programas vencem em 2 dias. Data: 13/11/2026');
  assert.equal(resolveNotice(s,'2026-11-11',NOW).message, 'Hoje é o prazo de 11/11/2026');
  assert.equal(validTemplate('Aviso em {prazo}.'),true);
  assert.equal(validTemplate('Aviso {token}'),false);
  assert.equal(validTemplate('<script>alert(1)</script>'),false);
});
test('Limites inclusivos e data de calendário de São Paulo', () => {
  assert.equal(resolveNotice(cfg({daysBefore: 1}), '2026-11-12',NOW).daysLeft,1);
  assert.equal(resolveNotice(cfg({daysBefore: 1}), '2026-11-13',NOW),null);
  assert.equal(resolveNotice(cfg(), '2026-11-11',new Date('2026-11-12T01:00:00Z')).daysLeft,0);
});

const KEY = {activationId:'client-123', dueDate:'2026-11-14', daysLeft:2};
const ID1 = 'b19cb338-d6af-4db2-9076-c9eb4e593001';
const ID2 = 'b19cb338-d6af-4db2-9076-c9eb4e593002';
test('uma vez por dia não repete no mesmo dia nem ao reabrir', () => {
  const a = makeExpiryNoticeKey({...KEY, deliveryMode:'daily', launchId: ID1});
  const b = makeExpiryNoticeKey({...KEY, deliveryMode:'daily', launchId: ID2});
  assert.equal(a,b);
  assert.notEqual(a,makeExpiryNoticeKey({...KEY, daysLeft:1}));
});
test('a cada abertura reexibe na nova execução, não no reconnect', () => {
  const a = makeExpiryNoticeKey({...KEY, deliveryMode:'every_open', launchId: ID1});
  const again = makeExpiryNoticeKey({...KEY, deliveryMode:'every_open', launchId: ID1});
  const reopened = makeExpiryNoticeKey({...KEY, deliveryMode:'every_open', launchId: ID2});
  assert.equal(a,again);
  assert.notEqual(a,reopened);
});
test('aplicativos antigos sem ID de abertura continuam na regra diária', () => {
  assert.equal(makeExpiryNoticeKey({...KEY,deliveryMode:'every_open'}), makeExpiryNoticeKey({...KEY,deliveryMode:'daily'}));
  assert.equal(makeExpiryNoticeKey({...KEY,deliveryMode:'every_open',launchId:'../../invalid'}), makeExpiryNoticeKey({...KEY,deliveryMode:'daily'}));
});
