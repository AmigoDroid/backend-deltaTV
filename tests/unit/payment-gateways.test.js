import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crc16, buildPixPayload, normalizePixKey, txidOf } from '../../src/modules/distribution/gateways/brcode.js';
import { createInfinitePay, pickLinkUrl, normalizeHandle, HANDLE_RE } from '../../src/modules/distribution/gateways/infinitepay.js';
import { GATEWAY_PROVIDERS, isProvider } from '../../src/modules/distribution/gateways/index.js';

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('CRC16/CCITT-FALSE confere com o vetor padrão', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('BR Code: estrutura, valor em reais, ASCII maiúsculo e CRC válido', () => {
  const payload = buildPixPayload({ key: 'vendedor@exemplo.com', name: 'José da Silva', city: 'São Luís', amountCents: 123456, txid: txidOf('3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f') });
  assert.match(payload, /^000201010212/);
  assert.ok(payload.includes('0014br.gov.bcb.pix0120vendedor@exemplo.com'));
  assert.ok(payload.includes('5407' + '1234.56'));
  assert.ok(payload.includes('5913JOSE DA SILVA'));
  assert.ok(payload.includes('6008SAO LUIS'));
  assert.equal(payload.slice(-4), crc16(payload.slice(0, -4)));
  assert.equal(txidOf('3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f').length, 25);
});

test('BR Code recusa valor e dados inválidos', () => {
  assert.throws(() => buildPixPayload({ key: 'a@b.co', name: 'X', city: 'Y', amountCents: 0 }));
  assert.throws(() => buildPixPayload({ key: 'a@b.co', name: 'X', city: 'Y', amountCents: 1.5 }));
  assert.throws(() => buildPixPayload({ key: '', name: 'X', city: 'Y', amountCents: 100 }));
});

test('chaves Pix são normalizadas por tipo', () => {
  assert.equal(normalizePixKey('cpf_cnpj', '123.456.789-09'), '12345678909');
  assert.equal(normalizePixKey('cpf_cnpj', '123'), null);
  assert.equal(normalizePixKey('phone', '(98) 99999-8888'), '+5598999998888');
  assert.equal(normalizePixKey('phone', '+55 98 99999-8888'), '+5598999998888');
  assert.equal(normalizePixKey('email', 'Fulano@Exemplo.COM'), 'fulano@exemplo.com');
  assert.equal(normalizePixKey('email', 'sem-arroba'), null);
  assert.equal(normalizePixKey('random', '123E4567-E89B-12D3-A456-426655440000'), '123e4567-e89b-12d3-a456-426655440000');
  assert.equal(normalizePixKey('random', 'nao-uuid'), null);
  assert.equal(normalizePixKey('qualquer', 'x'), null);
});

test('InfinitePay: cria link em centavos, API Key só no cabeçalho e valid_until só com chave', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return jsonRes(200, { url: 'https://checkout.infinitepay.io/abc' }); };
  const common = { orderNsu: 'o-1', amountCents: 2500, description: 'DeltaTV: 5 licença(s)', redirectUrl: 'https://r.example/?pix_order=o-1', webhookUrl: 'https://api.example/w', validUntil: new Date('2026-12-01T12:00:00Z') };
  const withKey = createInfinitePay({ handle: 'loja', apiKey: 'inchk_segredo123', fetchImpl });
  const link = await withKey.createLink(common);
  assert.equal(link.url, 'https://checkout.infinitepay.io/abc');
  assert.equal(calls[0].url, 'https://api.checkout.infinitepay.io/links');
  assert.equal(calls[0].init.headers['X-Api-Key'], 'inchk_segredo123');
  assert.equal(calls[0].body.items[0].price, 2500);
  assert.equal(calls[0].body.order_nsu, 'o-1');
  assert.match(calls[0].body.options.valid_until, /-03:00$/);
  assert.equal(JSON.stringify(calls[0].body).includes('inchk_'), false);
  await createInfinitePay({ handle: 'loja', fetchImpl }).createLink(common);
  assert.equal(calls[1].init.headers['X-Api-Key'], undefined);
  assert.equal(calls[1].body.options, undefined);
});

test('InfinitePay: só aceita link https do domínio infinitepay.io', () => {
  assert.equal(pickLinkUrl({ url: 'https://checkout.infinitepay.io/x' }), 'https://checkout.infinitepay.io/x');
  assert.equal(pickLinkUrl({ link: 'https://infinitepay.io/x' }), 'https://infinitepay.io/x');
  assert.equal(pickLinkUrl({ url: 'http://checkout.infinitepay.io/x' }), null);
  assert.equal(pickLinkUrl({ url: 'https://infinitepay.io.evil.com/x' }), null);
  assert.equal(pickLinkUrl({ url: 'https://evil.com/infinitepay.io' }), null);
  assert.equal(pickLinkUrl({}), null);
});

test('InfinitePay: erros do provedor viram mensagens controladas', async () => {
  const mk = (status, body) => createInfinitePay({ handle: 'loja', fetchImpl: async () => jsonRes(status, body) });
  const args = { orderNsu: 'o', amountCents: 100, description: 'x', redirectUrl: 'https://r', webhookUrl: 'https://w' };
  await assert.rejects(() => mk(403, {}).createLink(args), (e) => e.code === 'INFINITEPAY_FORBIDDEN');
  await assert.rejects(() => mk(400, { message: 'x' }).createLink(args), (e) => e.code === 'INFINITEPAY_REJECTED');
  await assert.rejects(() => mk(200, { ok: 1 }).createLink(args), (e) => e.code === 'INFINITEPAY_BAD_RESPONSE');
  const offline = createInfinitePay({ handle: 'loja', fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(() => offline.createLink(args), (e) => e.status === 502);
});

test('payment_check: pago só com success e paid verdadeiros', async () => {
  const check = (status, body) => createInfinitePay({ handle: 'loja', fetchImpl: async () => jsonRes(status, body) })
    .paymentCheck({ orderNsu: 'o', transactionNsu: 't', slug: 's' });
  assert.deepEqual(await check(200, { success: true, paid: true, amount: 1500, paid_amount: 1510, capture_method: 'pix' }),
    { paid: true, amountCents: 1500, paidAmountCents: 1510, captureMethod: 'pix' });
  assert.equal((await check(200, { success: true, paid: false })).paid, false);
  assert.equal((await check(200, { success: false, paid: true })).paid, false);
  assert.equal((await check(404, { success: false })).paid, false);
  await assert.rejects(() => check(503, {}), (e) => e.status === 502);
});

test('handle da InfiniteTag é normalizado e validado', () => {
  assert.equal(normalizeHandle(' $minhaloja '), 'minhaloja');
  assert.equal(HANDLE_RE.test('minha loja'), false);
  assert.equal(HANDLE_RE.test('minha_loja-1'), true);
});

test('provedores aceitos', () => {
  assert.deepEqual([...GATEWAY_PROVIDERS], ['mercadopago', 'infinitepay', 'manual_pix']);
  assert.equal(isProvider('paypal'), false);
});

test('InfinitePay: webhook e retorno só entregam depois do /payment_check, sem gravar dados do aviso antes', () => {
  const code = read('modules/distribution/gateway-orders.service.js');
  const webhook = code.slice(code.indexOf('export async function handleInfinitePayWebhook'), code.indexOf('export async function confirmInfinitePayReturn'));
  assert.doesNotMatch(webhook, /UPDATE|INSERT/);
  assert.match(webhook, /verifyInfinitePayment/);
  const verify = code.slice(code.indexOf('export async function verifyInfinitePayment'), code.indexOf('export async function handleInfinitePayWebhook'));
  assert.ok(verify.indexOf('paymentCheck') < verify.indexOf('deliverPaid'));
  assert.match(verify, /check\.amountCents !== Number\(current\.total_cents\)/);
  assert.match(verify, /Pagamento recebido após o prazo/);
});

test('Pix com chave própria: só o vendedor confirma e o comprador não se autoconfirma', () => {
  const code = read('modules/distribution/gateway-orders.service.js');
  assert.match(code, /ownedManual\(t, orderId, 'seller_partner_id', sellerId\)/);
  const claim = code.slice(code.indexOf('export async function claimPaid'), code.indexOf('export async function cancelByBuyer'));
  assert.doesNotMatch(claim, /deliverPaid/);
  const routes = read('modules/distribution/master-pix.routes.js');
  assert.match(routes, /'\/sales\/:id\/confirm'/);
  assert.match(routes, /'\/orders\/:id\/claim-paid'/);
});

test('migração é aditiva e copia as contas Mercado Pago existentes', () => {
  const sql = read('db/migrations/20261220000001-payment-gateways.cjs');
  assert.match(sql, /CREATE TABLE reseller_payment_gateways/);
  assert.match(sql, /INSERT INTO reseller_payment_gateways[\s\S]*FROM reseller_master_pix_accounts/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|UPDATE reseller_master_pix_orders/);
  assert.match(sql, /IN \('mercadopago','infinitepay','manual_pix'\)/);
});

test('credenciais nunca saem na listagem de meios de recebimento', () => {
  const code = read('modules/distribution/gateway-settings.service.js');
  const list = code.slice(code.indexOf('export async function listGateways'), code.indexOf('async function upsert'));
  assert.doesNotMatch(list, /access_token_enc[^)]*\)\s*AS has_secret[\s\S]*return[\s\S]*access_token_enc/);
  assert.doesNotMatch(list.slice(list.indexOf('return GATEWAY_PROVIDERS')), /access_token_enc|webhook_secret/);
});
