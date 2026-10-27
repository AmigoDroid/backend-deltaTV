import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  amountToCents, centsToAmount, createMercadoPago, mapStatus, toMpDate, verifySignature,
} from "../../src/modules/pix/providers/mercadopago.js";
import { resolvePrices } from "../../src/modules/pix/price-rules.js";

const sign = (secret, { id, requestId, ts }) =>
  crypto.createHmac("sha256", secret).update(`id:${id};request-id:${requestId};ts:${ts};`).digest("hex");

test("valores: centavos <-> reais sem erro de ponto flutuante", () => {
  assert.equal(centsToAmount(12345), 123.45);
  assert.equal(centsToAmount(1), 0.01);
  assert.equal(amountToCents(123.45), 12345);
  assert.equal(amountToCents(0.29), 29); // 0.29*100 = 28.999999999999996
  assert.equal(amountToCents("19.9"), 1990);
});

test("data de expiração no formato do Mercado Pago (UTC-3)", () => {
  assert.equal(toMpDate(new Date("2026-10-26T19:30:00.000Z")), "2026-10-26T16:30:00.000-03:00");
});

test("status do Mercado Pago -> status interno", () => {
  assert.equal(mapStatus("approved"), "paid");
  assert.equal(mapStatus("pending"), "pending");
  assert.equal(mapStatus("in_process"), "pending");
  assert.equal(mapStatus("cancelled"), "cancelled");
  assert.equal(mapStatus("rejected"), "cancelled");
  assert.equal(mapStatus("refunded"), "refunded");
  assert.equal(mapStatus("charged_back"), "refunded");
  assert.equal(mapStatus("qualquer-coisa-nova"), "pending"); // desconhecido NUNCA vira "paid"
});

test("assinatura do webhook: válida, adulterada, sem segredo e formatos inválidos", () => {
  const secret = "segredo-do-webhook";
  const ts = "1742505638683";
  const v1 = sign(secret, { id: "123456", requestId: "req-1", ts });
  const header = `ts=${ts},v1=${v1}`;
  assert.equal(verifySignature({ secret, signatureHeader: header, requestId: "req-1", dataId: "123456" }), true);
  assert.equal(verifySignature({ secret, signatureHeader: header, requestId: "req-1", dataId: "999999" }), false); // outro pagamento
  assert.equal(verifySignature({ secret, signatureHeader: header, requestId: "req-2", dataId: "123456" }), false);
  assert.equal(verifySignature({ secret: "outro", signatureHeader: header, requestId: "req-1", dataId: "123456" }), false);
  assert.equal(verifySignature({ secret, signatureHeader: `ts=${ts},v1=zz`, requestId: "req-1", dataId: "123456" }), false);
  assert.equal(verifySignature({ secret, signatureHeader: `v1=${v1}`, requestId: "req-1", dataId: "123456" }), false); // sem ts
  assert.equal(verifySignature({ secret, signatureHeader: undefined, requestId: "req-1", dataId: "123456" }), false);
  assert.equal(verifySignature({ secret: "", signatureHeader: header, requestId: "req-1", dataId: "123456" }), false);
});

test("assinatura: data.id alfanumérico entra em minúsculas no manifesto", () => {
  const secret = "s";
  const ts = "1";
  const v1 = crypto.createHmac("sha256", secret).update(`id:abc123;request-id:r;ts:${ts};`).digest("hex");
  assert.equal(verifySignature({ secret, signatureHeader: `ts=${ts},v1=${v1}`, requestId: "r", dataId: "ABC123" }), true);
});

const fakeReq = ({ query = {}, body = {}, headers = {} } = {}) => ({ query, body, get: (h) => headers[h.toLowerCase()] });

test("webhook: verifyWebhook usa query data.id e só aceita notificações de pagamento", () => {
  const secret = "wh";
  const mp = createMercadoPago({ accessToken: "T", webhookSecret: secret, fetchImpl: async () => { throw new Error("sem rede"); } });
  const ts = "100";
  const v1 = sign(secret, { id: "555", requestId: "rid", ts });
  const ok = fakeReq({ query: { "data.id": "555", type: "payment" }, headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": "rid" } });
  assert.equal(mp.verifyWebhook(ok), true);
  assert.equal(mp.paymentIdFromWebhook(ok), "555");
  const forged = fakeReq({ query: { "data.id": "556", type: "payment" }, headers: { "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": "rid" } });
  assert.equal(mp.verifyWebhook(forged), false);
  assert.equal(mp.paymentIdFromWebhook(fakeReq({ query: { "data.id": "555", type: "merchant_order" } })), null);
  assert.equal(mp.paymentIdFromWebhook(fakeReq({ body: { type: "payment", data: { id: "77" } } })), "77");
  assert.equal(mp.paymentIdFromWebhook(fakeReq({ query: { "data.id": "../../etc" } })), null); // id precisa ser numérico
  // sem segredo configurado: aceita (a segurança vem de reconsultar o pagamento na API)
  assert.equal(createMercadoPago({ accessToken: "T" }).verifyWebhook(fakeReq()), true);
});

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, json } = await handler(url, init, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}

test("createCharge: monta o pedido do Pix e lê o QR Code", async () => {
  const f = fakeFetch(() => ({ status: 201, json: {
    id: 987654321, status: "pending", date_of_expiration: "2026-10-26T17:30:00.000-03:00",
    point_of_interaction: { transaction_data: { qr_code: "00020126...", qr_code_base64: "iVBOR...", ticket_url: "https://mp/ticket" } },
  } }));
  const mp = createMercadoPago({ accessToken: "APP_USR-xyz", fetchImpl: f });
  const r = await mp.createCharge({
    id: "11111111-1111-1111-1111-111111111111", amountCents: 12050, description: "10 licenças",
    payer: { email: "a@b.com", name: "Fulano" }, expiresAt: new Date("2026-10-26T20:30:00Z"), notificationUrl: "https://api.x/hook",
  });
  assert.equal(r.providerRef, "987654321");
  assert.equal(r.qrCode, "00020126...");
  assert.equal(r.qrCodeBase64, "iVBOR...");
  const c = f.calls[0];
  assert.equal(c.url, "https://api.mercadopago.com/v1/payments");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Bearer APP_USR-xyz");
  assert.equal(c.init.headers["X-Idempotency-Key"], "11111111-1111-1111-1111-111111111111");
  assert.equal(c.body.transaction_amount, 120.5);
  assert.equal(c.body.payment_method_id, "pix");
  assert.equal(c.body.external_reference, "11111111-1111-1111-1111-111111111111");
  assert.equal(c.body.notification_url, "https://api.x/hook");
  assert.equal(c.body.payer.email, "a@b.com");
  assert.equal(c.body.date_of_expiration, "2026-10-26T17:30:00.000-03:00");
});

test("createCharge: erro do provedor vira 502 sem vazar detalhes nem token", async () => {
  const mp = createMercadoPago({ accessToken: "SEGREDO", fetchImpl: fakeFetch(() => ({ status: 400, json: { message: "invalid payer" } })) });
  await assert.rejects(
    () => mp.createCharge({ id: "x", amountCents: 100, description: "d", payer: { email: "a@b.com" }, expiresAt: new Date() }),
    (e) => e.status === 502 && e.code === "PIX_PROVIDER_ERROR" && !String(e.message).includes("SEGREDO") && !String(e.message).includes("invalid payer"),
  );
  const down = createMercadoPago({ accessToken: "T", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => down.createCharge({ id: "x", amountCents: 100, description: "d", payer: { email: "a@b.com" }, expiresAt: new Date() }), (e) => e.status === 502 && e.code === "PIX_PROVIDER_UNAVAILABLE");
});

test("createCharge: resposta sem QR Code é erro (não gera cobrança 'fantasma')", async () => {
  const mp = createMercadoPago({ accessToken: "T", fetchImpl: fakeFetch(() => ({ status: 201, json: { id: 1, status: "pending" } })) });
  await assert.rejects(() => mp.createCharge({ id: "x", amountCents: 100, description: "d", payer: { email: "a@b.com" }, expiresAt: new Date() }), (e) => e.status === 502);
});

test("getPayment: normaliza status, valor e referência externa", async () => {
  const f = fakeFetch(() => ({ json: { id: 42, status: "approved", payment_method_id: "pix", transaction_amount: 120.5, external_reference: "abc", date_approved: "2026-10-26T16:00:00.000-03:00" } }));
  const info = await createMercadoPago({ accessToken: "T", fetchImpl: f }).getPayment("42");
  assert.deepEqual({ ...info, paidAt: info.paidAt.toISOString() }, {
    providerRef: "42", status: "paid", rawStatus: "approved", amountCents: 12050, externalReference: "abc", paidAt: "2026-10-26T19:00:00.000Z",
  });
  assert.equal(f.calls[0].url, "https://api.mercadopago.com/v1/payments/42");
  assert.equal(f.calls[0].init.method, "GET");
});

test("getPayment: recusa id que não é numérico (nada de path traversal) e pagamento que não é Pix", async () => {
  const f = fakeFetch(() => ({ json: { id: 1, status: "approved", payment_method_id: "visa", transaction_amount: 1 } }));
  const mp = createMercadoPago({ accessToken: "T", fetchImpl: f });
  await assert.rejects(() => mp.getPayment("../users/me"), (e) => e.code === "PIX_INVALID_REF");
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => mp.getPayment("1"), (e) => e.code === "PIX_NOT_PIX");
});

test("getPayment: 404 do provedor vira PIX_PAYMENT_NOT_FOUND", async () => {
  const mp = createMercadoPago({ accessToken: "T", fetchImpl: fakeFetch(() => ({ status: 404, json: { message: "not found" } })) });
  await assert.rejects(() => mp.getPayment("9"), (e) => e.status === 404 && e.code === "PIX_PAYMENT_NOT_FOUND");
});

test("preços: tabela geral, preço do revendedor sobrepõe e active=false esconde a duração", () => {
  const rows = [
    { partnerId: null, months: 1, priceCents: 1500, active: true },
    { partnerId: null, months: 3, priceCents: 4000, active: true },
    { partnerId: null, months: 12, priceCents: 12000, active: true },
    { partnerId: null, months: 6, priceCents: 7000, active: false }, // fora de venda para todos
    { partnerId: "p1", months: 1, priceCents: 1200, active: true }, // preço combinado
    { partnerId: "p1", months: 12, priceCents: 1, active: false }, // não vende 12 meses a este revendedor
    { partnerId: "p1", months: 24, priceCents: 20000, active: true }, // duração só dele
  ];
  assert.deepEqual(resolvePrices(rows), [
    { months: 1, priceCents: 1200, custom: true },
    { months: 3, priceCents: 4000, custom: false },
    { months: 24, priceCents: 20000, custom: true },
  ]);
  assert.deepEqual(resolvePrices(rows.filter((r) => r.partnerId === null)).map((p) => p.months), [1, 3, 12]);
  assert.deepEqual(resolvePrices([]), []);
});
