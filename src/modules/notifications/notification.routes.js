import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Op, QueryTypes } from "sequelize";
import { sequelize } from "../../db/sequelize.js";
import { Partner, PartnerNotification, NotificationCampaign } from "../../db/models/index.js";
import { authenticate, requirePartnerRole } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { AppError } from "../../shared/errors.js";
import { broadcastPartnerNotification, broadcastNotificationRefresh } from "../../realtime/socket.js";

export const adminNotificationRoutes = Router();
adminNotificationRoutes.use(authenticate);
adminNotificationRoutes.use((req, _res, next) => req.user.role === "superadmin" ? next() : next(new AppError(403, "FORBIDDEN", "Somente o superadmin pode enviar notificações.")));
const sendSchema = z.object({
  audience: z.enum(["all", "selected"]), partnerIds: z.array(z.string().uuid()).max(500).default([]),
  title: z.string().trim().min(3).max(140), message: z.string().trim().min(3).max(4000),
  severity: z.enum(["info", "important", "warning"]).default("info"),
});
// Busca paginada no banco: nunca transfere o cadastro completo para o navegador.
adminNotificationRoutes.get("/recipient-search", validate({ query: z.object({ q: z.string().trim().max(100).default(""), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(30).default(20) }) }), async (req, res) => {
  const { q, page, limit } = req.valid.query;
  const where = { kind: { [Op.in]: ["reseller", "both"] } };
  if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q.replace(/[\\%_]/g, "\\$&")}%` } }, { slug: { [Op.iLike]: `%${q.replace(/[\\%_]/g, "\\$&")}%` } }, { contactEmail: { [Op.iLike]: `%${q.replace(/[\\%_]/g, "\\$&")}%` } }];
  const { rows, count } = await Partner.findAndCountAll({ where, attributes: ["id", "name", "slug", "status"], limit, offset: (page-1)*limit, order: [["name", "ASC"], ["id", "ASC"]] });
  res.set("Cache-Control", "no-store").json({ data: rows, meta: { page, total: count, pages: Math.ceil(count / limit) } });
});
adminNotificationRoutes.post("/send", validate({ body: sendSchema }), async (req, res) => {
  const { audience, partnerIds, title, message, severity } = req.valid.body;
  const selected = [...new Set(partnerIds)];
  if (audience === "selected" && selected.length === 0)
    throw new AppError(400, "NO_RECIPIENTS", "Selecione pelo menos uma revenda.");
  const scope = { kind: { [Op.in]: ["reseller", "both"] } };
  if (audience === "selected") scope.id = { [Op.in]: selected };
  const total = await Partner.count({ where: scope });
  if (audience === "selected" && total !== selected.length)
    throw new AppError(400, "INVALID_RECIPIENTS", "Uma ou mais revendas não existem ou não são revendedoras.");
  if (!total) throw new AppError(400, "NO_RECIPIENTS", "Nenhuma revenda encontrada.");

  const campaignId = randomUUID();
  // Uma transação atômica, mas sem carregar todos os destinatários de uma vez.
  // Cada lote mantém no máximo 250 modelos na memória do Node.
  let inserted = 0;
  await sequelize.transaction(async transaction => {
    await NotificationCampaign.create({ id: campaignId, senderId: req.user.id, title, message, severity }, { transaction });
    let cursor = null;
    while (true) {
      const where = { ...scope, ...(cursor ? { id: audience === "selected"
        ? { [Op.in]: selected, [Op.gt]: cursor } : { [Op.gt]: cursor } } : {}) };
      const batch = await Partner.findAll({ where, attributes: ["id"], order: [["id", "ASC"]], limit: 250, transaction, raw: true });
      if (!batch.length) break;
      await PartnerNotification.bulkCreate(
        batch.map(p => ({ partnerId: p.id, campaignId, senderId: req.user.id, batchId: campaignId })),
        { transaction, returning: false },
      );
      inserted += batch.length;
      cursor = batch[batch.length - 1].id;
    }
  });
  // Notificações WS apenas após commit, nunca antes de a mensagem existir no banco.
  broadcastNotificationRefresh(audience === "all" ? null : selected);
  res.status(201).json({ campaignId, sent: inserted });
});
// Um comunicado por envio. Cada entrega com seu read_at é um filho.
adminNotificationRoutes.get("/campaigns", validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) }) }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const [rows, count] = await Promise.all([
    sequelize.query(`
      SELECT c.id, c.title, c.message, c.severity, c.created_at AS "createdAt",
             COUNT(n.id)::int AS "total", COUNT(n.read_at)::int AS "read",
             (COUNT(n.id) - COUNT(n.read_at))::int AS "unread"
      FROM (SELECT * FROM notification_campaigns ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset) c
      LEFT JOIN partner_notifications n ON n.campaign_id = c.id
      GROUP BY c.id, c.title, c.message, c.severity, c.created_at
      ORDER BY c.created_at DESC, c.id DESC
    `, { type: QueryTypes.SELECT, replacements: { limit, offset: (page - 1) * limit } }),
    NotificationCampaign.count(),
  ]);
  res.set("Cache-Control", "no-store").json({ data: rows, meta: { page, pages: Math.ceil(count / limit), total: count } });
});

// Compatibilidade com clientes administrativos antigos.
adminNotificationRoutes.get("/history", validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) }) }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const { rows, count } = await NotificationCampaign.findAndCountAll({ limit, offset: (page - 1) * limit, order: [["createdAt", "DESC"], ["id", "DESC"]] });
  res.json({ data: rows, meta: { page, total: count, pages: Math.ceil(count / limit) } });
});

adminNotificationRoutes.get("/campaigns/:id/recipients", validate({ params: z.object({ id: z.string().uuid() }), query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50) }) }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const campaign = await NotificationCampaign.findByPk(req.valid.params.id);
  if (!campaign) throw new AppError(404, "NOT_FOUND", "Comunicado não encontrado.");
  const { rows, count } = await PartnerNotification.findAndCountAll({ where: { campaignId: campaign.id }, attributes: ["id", "partnerId", "readAt", "createdAt"], order: [["createdAt", "ASC"], ["id", "ASC"]], limit, offset: (page - 1) * limit });
  const ids = [...new Set(rows.map(r => r.partnerId))];
  const partners = ids.length ? await Partner.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name", "slug"] }) : [];
  const names = new Map(partners.map(p => [p.id, { name: p.name, slug: p.slug }]));
  res.set("Cache-Control", "no-store").json({ data: rows.map(r => ({ id: r.id, partnerId: r.partnerId, partnerName: names.get(r.partnerId)?.name || "Revenda excluída", partnerSlug: names.get(r.partnerId)?.slug || null, readAt: r.readAt, sentAt: r.createdAt })), meta: { page, total: count, pages: Math.ceil(count / limit) } });
});

export const partnerNotificationRoutes = Router();
partnerNotificationRoutes.use(authenticate, requirePartnerRole);
partnerNotificationRoutes.get("/", validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) }) }), async (req, res) => {
  const { page, limit } = req.valid.query;
  const where = { partnerId: req.user.partnerId };
  const [{ rows, count }, unread] = await Promise.all([
    PartnerNotification.findAndCountAll({ where, include: [{ model: NotificationCampaign, as: "campaign", required: true, attributes: ["title", "message", "severity"] }], limit, offset: (page - 1) * limit, order: [["createdAt", "DESC"]] }),
    PartnerNotification.count({ where: { ...where, readAt: null } }),
  ]);
  res.set("Cache-Control", "no-store").json({ data: rows.map(r => {
    const { campaign, ...delivery } = r.get({ plain: true });
    return { ...delivery, title: campaign.title, message: campaign.message, severity: campaign.severity };
  }), unread, meta: { page, total: count, pages: Math.ceil(count / limit) } });
});
partnerNotificationRoutes.patch("/:id/read", validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) => {
  const [affected] = await PartnerNotification.update({ readAt: new Date() }, { where: { id: req.valid.params.id, partnerId: req.user.partnerId, readAt: null } });
  if (!affected) {
    const exists = await PartnerNotification.findOne({ where: { id: req.valid.params.id, partnerId: req.user.partnerId } });
    if (!exists) throw new AppError(404, "NOT_FOUND", "Notificação não encontrada.");
  }
  res.json({ ok: true });
});
partnerNotificationRoutes.post("/read-all", async (req, res) => {
  const [updated] = await PartnerNotification.update({ readAt: new Date() }, { where: { partnerId: req.user.partnerId, readAt: null } });
  res.json({ updated });
});
