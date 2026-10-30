import { Router } from "express";
import { z } from "zod";
import { validate } from "../../shared/validate.js";
import { pageQuery } from "../../shared/pagination.js";
import { actorOf } from "../../shared/audit.js";
import { requirePermission } from "../../middleware/authenticate.js";
import { stockWriteLimiter, pixReadLimiter } from "../../middleware/security.js";
import { loadReseller, assertReseller } from "../devices/reseller-devices.service.js";
import { pixEnabled } from "../pix/providers/index.js";
import * as svc from "./credit.service.js";

const id = z.object({ id: z.string().uuid() });
const partnerParam = z.object({ partnerId: z.string().uuid() });

/* ================= Portal do revendedor (/api/v1/partner/credits) ================= */
// Montado depois de authenticate + requirePartnerRole: o partnerId vem SEMPRE do token. O cliente nunca informa preço.
// A recarga por Pix fica em /partner/pix/credits (mesmo fluxo e limites das demais cobranças Pix).
export const partnerRouter = Router();

const requireReseller = async (req, _res, next) => {
  const partner = await loadReseller(req.user.partnerId);
  assertReseller(partner);
  req.reseller = { partner };
  next();
};

partnerRouter.get("/", pixReadLimiter, requireReseller, async (req, res) =>
  res.set("Cache-Control", "no-store").json(await svc.overviewFor(req.reseller.partner, { pixEnabled: pixEnabled() })));

partnerRouter.get("/ledger", pixReadLimiter, requireReseller, validate({ query: z.object({ ...pageQuery }) }), async (req, res) =>
  res.set("Cache-Control", "no-store").json(await svc.listLedger({ partnerId: req.user.partnerId, ...req.valid.query })));

partnerRouter.post(
  "/buy", stockWriteLimiter, requireReseller,
  validate({ body: z.object({ months: z.number().int().min(1).max(120), quantity: z.number().int().min(1).max(svc.MAX_BUY_QUANTITY) }) }),
  async (req, res) => res.json(await svc.buyLicenses({ partner: req.reseller.partner, actor: actorOf(req), ...req.valid.body })),
);

/* ================= Painel admin (/api/v1/admin/credits) ================= */
export const adminRouter = Router();

// Câmbio: quantos centavos de R$ vale 1 crédito (geral; ou combinado com um revendedor).
adminRouter.get("/rates", requirePermission("billing:read"), async (_req, res) => res.json(await svc.listRates()));
adminRouter.put(
  "/rates", requirePermission("billing:write"),
  validate({ body: z.object({ partnerId: z.string().uuid().nullable().optional(), rateCents: z.number().int().min(1).max(10_000_000) }) }),
  async (req, res) => res.json(await svc.setRate(req.valid.body, actorOf(req))),
);
adminRouter.delete("/rates/:id", requirePermission("billing:write"), validate({ params: id }), async (req, res) => {
  await svc.deleteRate(req.valid.params.id, actorOf(req));
  res.status(204).end();
});

// Preço de 1 licença, por duração, em créditos (tabela geral; ?partnerId= para o combinado com um revendedor).
adminRouter.get("/prices", requirePermission("billing:read"), validate({ query: z.object({ partnerId: z.string().uuid().optional() }) }), async (req, res) =>
  res.json({ data: await svc.listPrices(req.valid.query) }));
adminRouter.put(
  "/prices", requirePermission("billing:write"),
  validate({ body: z.object({ partnerId: z.string().uuid().nullable().optional(), months: z.number().int().min(1).max(120), priceCredits: z.number().int().min(1).max(1_000_000), active: z.boolean().default(true) }) }),
  async (req, res) => res.json(await svc.setPrice(req.valid.body, actorOf(req))),
);
adminRouter.delete("/prices/:id", requirePermission("billing:write"), validate({ params: id }), async (req, res) => {
  await svc.deletePrice(req.valid.params.id, actorOf(req));
  res.status(204).end();
});

// Carteiras e extrato.
adminRouter.get("/wallets", requirePermission("billing:read"), validate({ query: z.object({ ...pageQuery, q: z.string().trim().max(60).optional() }) }), async (req, res) =>
  res.json(await svc.listWallets(req.valid.query)));
adminRouter.get(
  "/ledger", requirePermission("billing:read"),
  validate({ query: z.object({ ...pageQuery, partnerId: z.string().uuid().optional(), kind: z.enum(["topup", "purchase", "adjust"]).optional() }) }),
  async (req, res) => res.json(await svc.listLedger(req.valid.query, { admin: true })),
);
adminRouter.post(
  "/wallets/:partnerId/adjust", requirePermission("billing:write"),
  validate({ params: partnerParam, body: z.object({
    delta: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Informe um valor diferente de zero."),
    note: z.string().trim().min(3).max(300),
  }) }),
  async (req, res) => res.json(await svc.adjustCredit(req.valid.params.partnerId, req.valid.body, actorOf(req))),
);
