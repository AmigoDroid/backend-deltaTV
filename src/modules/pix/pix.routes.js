import { Router } from "express";
import { z } from "zod";
import { Partner } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf } from "../../shared/audit.js";
import { env } from "../../config/env.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { pixCreateLimiter, pixReadLimiter, webhookLimiter } from "../../middleware/security.js";
import { loadReseller, assertReseller } from "../devices/reseller-devices.service.js";
import { STOCK_KINDS } from "../stock/stock-ledger.js";
import { getProvider } from "./providers/index.js";
import * as svc from "./pix.service.js";
import * as prices from "./pix.pricing.js";

const id = z.object({ id: z.string().uuid() });
const cents = z.number().int().min(1).max(100_000_000);

/* ================= Portal do parceiro (/api/v1/partner/pix) ================= */
// Montado depois de authenticate + requirePartnerRole: o partnerId vem SEMPRE do token. O cliente nunca informa valores.
export const partnerRouter = Router();

const requireReseller = async (req, _res, next) => {
  const partner = await loadReseller(req.user.partnerId);
  assertReseller(partner);
  req.reseller = { partner };
  next();
};
const loadPartner = async (req, _res, next) => {
  const partner = await Partner.findByPk(req.user.partnerId);
  if (!partner) throw notFound("Parceiro");
  req.pixPartner = partner;
  next();
};

// Quais durações o parceiro pode comprar e a seu preço (para a tela montar o formulário). Pix desligado => enabled=false.
partnerRouter.get("/config", loadPartner, async (req, res) => {
  const enabled = svc.pixEnabled();
  const canBuyStock = STOCK_KINDS.includes(req.pixPartner.kind);
  res.json({
    enabled, canBuyStock, maxQuantity: svc.MAX_STOCK_QUANTITY,
    prices: enabled && canBuyStock ? await prices.pricesFor(req.pixPartner.id) : [],
  });
});

partnerRouter.post("/invoices/:id", pixCreateLimiter, loadPartner, validate({ params: id }), async (req, res) => {
  const charge = await svc.createInvoiceCharge({ partner: req.pixPartner, user: req.user, actor: actorOf(req), invoiceId: req.valid.params.id });
  res.status(201).json(svc.chargeView(charge));
});

partnerRouter.post(
  "/stock", pixCreateLimiter, requireReseller,
  validate({ body: z.object({ months: z.number().int().min(1).max(120), quantity: z.number().int().min(1).max(svc.MAX_STOCK_QUANTITY) }) }),
  async (req, res) => {
    const charge = await svc.createStockCharge({ partner: req.reseller.partner, user: req.user, actor: actorOf(req), ...req.valid.body });
    res.status(201).json(svc.chargeView(charge));
  },
);

partnerRouter.get("/charges", pixReadLimiter, validate({ query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.json(await svc.listChargesFor({ partnerId: req.user.partnerId, ...req.valid.query })));
// Polling da tela do QR Code: consulta o provedor no máximo a cada poucos segundos (ver CHECK_INTERVAL_MS).
partnerRouter.get("/charges/:id", pixReadLimiter, validate({ params: id }), async (req, res) =>
  res.json(svc.chargeView(await svc.getChargeFor({ partnerId: req.user.partnerId, id: req.valid.params.id }))));

/* ================= Painel admin (/api/v1/admin/pix) ================= */
export const adminRouter = Router();

adminRouter.get("/config", requirePermission("billing:read"), (_req, res) =>
  res.json({ enabled: svc.pixEnabled(), provider: env.pixProvider || null, webhookUrl: svc.webhookUrl() ?? null, expirationMinutes: env.pixExpirationMinutes }));

adminRouter.get(
  "/charges", requirePermission("billing:read"),
  validate({ query: z.object({
    ...pageQuery, status: z.enum(["pending", "paid", "expired", "cancelled", "failed", "review", "refunded"]).optional(),
    partnerId: z.string().uuid().optional(), purpose: z.enum(["invoice", "stock"]).optional(),
  }) }),
  async (req, res) => res.json(await svc.listCharges(req.valid.query)),
);
adminRouter.post("/charges/:id/reprocess", requirePermission("billing:write"), validate({ params: id }), async (req, res) =>
  res.json(await svc.reprocessCharge(req.valid.params.id, actorOf(req))));
adminRouter.post("/charges/:id/resolve", requirePermission("billing:write"), validate({ params: id, body: z.object({ note: z.string().trim().min(3).max(300) }) }), async (req, res) =>
  res.json(await svc.resolveCharge(req.valid.params.id, req.valid.body, actorOf(req))));
adminRouter.post("/charges/:id/simulate-payment", requirePermission("billing:write"), validate({ params: id }), async (req, res) =>
  res.json(await svc.simulatePayment(req.valid.params.id, actorOf(req))));

// Preços das licenças (tabela geral; ?partnerId= para os preços combinados com um revendedor).
adminRouter.get("/prices", requirePermission("billing:read"), validate({ query: z.object({ partnerId: z.string().uuid().optional() }) }), async (req, res) =>
  res.json({ data: await prices.listPrices(req.valid.query) }));
adminRouter.put(
  "/prices", requirePermission("billing:write"),
  validate({ body: z.object({ partnerId: z.string().uuid().nullable().optional(), months: z.number().int().min(1).max(120), priceCents: cents, active: z.boolean().default(true) }) }),
  async (req, res) => res.json(await prices.setPrice(req.valid.body, actorOf(req))),
);
adminRouter.delete("/prices/:id", requirePermission("billing:write"), validate({ params: id }), async (req, res) => {
  await prices.deletePrice(req.valid.params.id, actorOf(req));
  res.status(204).end();
});

/* ================= Webhook (/api/v1/webhooks/pix) ================= */
export const webhookRouter = Router();

// Mercado Pago: POST ...?data.id=123&type=payment (corpo {action, type, data:{id}}). A resposta 200 encerra as reentregas.
webhookRouter.post("/mercadopago", webhookLimiter, async (req, res) => {
  if (env.pixProvider !== "mercadopago") throw new AppError(404, "NOT_FOUND", "Rota não encontrada.");
  const provider = getProvider();
  if (!provider.verifyWebhook(req)) throw new AppError(401, "INVALID_SIGNATURE", "Assinatura inválida.");
  const paymentId = provider.paymentIdFromWebhook(req);
  if (!paymentId) return res.json({ ok: true, ignored: true }); // outro tipo de evento (merchant_order, etc.)
  const r = await svc.handleNotification("mercadopago", paymentId, { type: "webhook", id: "mercadopago", ip: req.ip });
  res.json({ ok: true, ...r });
});
