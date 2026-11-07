import { Router } from "express";
import { Op } from "sequelize";
import { z } from "zod";
import { HelpArticle, HelpUserProgress, HelpUserState, Partner, sequelize } from "../../db/models/index.js";
import { authenticate, requirePartnerRole } from "../../middleware/authenticate.js";
import { actorOf, audit } from "../../shared/audit.js";
import { AppError, notFound } from "../../shared/errors.js";
import { validate } from "../../shared/validate.js";
import { helpArticleFields, helpArticleUpdate, helpProgressInput } from "./help.schemas.js";

const byId = z.object({ id: z.string().uuid() });
const getData = (row) => row.get({ plain: true });
const audienceFor = (kind) => kind === "both" ? ["both", "content", "reseller"] : ["both", kind === "reseller" ? "reseller" : "content"];
const publicFields = ["id", "slug", "title", "summary", "category", "audience", "body", "imageUrl", "videoUrl", "steps", "sortOrder", "isOnboarding", "updatedAt"];

export const partnerHelpRoutes = Router();
partnerHelpRoutes.use(authenticate, requirePartnerRole);
partnerHelpRoutes.get("/", async (req, res) => {
  const partner = await Partner.findByPk(req.user.partnerId, { attributes: ["id", "kind", "status"] });
  if (!partner || partner.status === "deleted") throw notFound("Parceria");
  const [articles, progress, state] = await Promise.all([
    HelpArticle.findAll({ where: { status: "published", audience: { [Op.in]: audienceFor(partner.kind) } }, attributes: publicFields, order: [["sortOrder", "ASC"], ["title", "ASC"]], limit: 200 }),
    HelpUserProgress.findAll({ where: { adminUserId: req.user.id }, attributes: ["articleId", "stepIndex", "completedAt", "updatedAt"] }),
    HelpUserState.findByPk(req.user.id, { attributes: ["welcomeSeenAt"] }),
  ]);
  res.set("Cache-Control", "no-store").json({ data: articles.map(getData), progress: progress.map(getData), welcomeSeenAt: state?.welcomeSeenAt ?? null });
});
partnerHelpRoutes.post("/welcome-seen", async (req, res) => {
  // Primeiro uso persiste no servidor, não em localStorage. Repetir não reinicia o tutorial.
  await HelpUserState.findOrCreate({ where: { adminUserId: req.user.id }, defaults: { welcomeSeenAt: new Date() } });
  await HelpUserState.update({ welcomeSeenAt: new Date() }, { where: { adminUserId: req.user.id, welcomeSeenAt: null } });
  res.set("Cache-Control", "no-store").json({ ok: true });
});
partnerHelpRoutes.put("/:id/progress", validate({ params: byId, body: helpProgressInput }), async (req, res) => {
  const partner = await Partner.findByPk(req.user.partnerId, { attributes: ["kind", "status"] });
  if (!partner || partner.status === "deleted") throw notFound("Parceria");
  const article = await HelpArticle.findOne({ where: { id: req.valid.params.id, status: "published", audience: { [Op.in]: audienceFor(partner.kind) } }, attributes: ["id", "steps"] });
  if (!article) throw notFound("Tutorial");
  const maxStep = Math.max(0, (article.steps || []).length - 1);
  if (req.valid.body.stepIndex > maxStep) throw new AppError(422, "INVALID_STEP", "Etapa fora do tutorial.");
  const where = { adminUserId: req.user.id, articleId: article.id };
  await HelpUserProgress.findOrCreate({ where, defaults: { stepIndex: 0 } });
  // Monotônico: duas abas / passos rápidos nunca regridem o progresso já salvo.
  // O índice é validado como inteiro 0..16; somente ele entra na expressão SQL.
  await HelpUserProgress.update({
    stepIndex: sequelize.literal(`GREATEST(step_index, ${req.valid.body.stepIndex})`),
    ...(req.valid.body.completed ? { completedAt: sequelize.literal("COALESCE(completed_at, CURRENT_TIMESTAMP)") } : {}),
  }, { where });
  const saved = await HelpUserProgress.findOne({ where, attributes: ["articleId", "stepIndex", "completedAt"] });
  res.set("Cache-Control", "no-store").json(saved.get({ plain: true }));
});

export const adminHelpRoutes = Router();
adminHelpRoutes.use(authenticate, (req, _res, next) => {
  if (req.user.role !== "superadmin") throw new AppError(403, "FORBIDDEN", "Somente o superadmin pode editar tutoriais.");
  next();
});
adminHelpRoutes.get("/", async (_req, res) => {
  const articles = await HelpArticle.findAll({ order: [["sortOrder", "ASC"], ["updatedAt", "DESC"]], limit: 300 });
  res.set("Cache-Control", "no-store").json({ data: articles.map(getData) });
});
adminHelpRoutes.post("/", validate({ body: helpArticleFields }), async (req, res) => {
  const article = await sequelize.transaction(async transaction => {
    const item = await HelpArticle.create({ ...req.valid.body, imageUrl: req.valid.body.imageUrl || null, videoUrl: req.valid.body.videoUrl || null }, { transaction });
    await audit({ actor: actorOf(req), action: "help.article.create", entityType: "help_article", entityId: item.id, metadata: { slug: item.slug, audience: item.audience }, transaction });
    return item;
  });
  res.status(201).json(getData(article));
});
adminHelpRoutes.patch("/:id", validate({ params: byId, body: helpArticleUpdate }), async (req, res) => {
  const article = await sequelize.transaction(async transaction => {
    const row = await HelpArticle.findByPk(req.valid.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw notFound("Tutorial");
    await row.update(req.valid.body, { transaction });
    await audit({ actor: actorOf(req), action: "help.article.update", entityType: "help_article", entityId: row.id, metadata: { fields: Object.keys(req.valid.body), status: row.status }, transaction });
    return row;
  });
  res.json(getData(article));
});
adminHelpRoutes.delete("/:id", validate({ params: byId }), async (req, res) => {
  await sequelize.transaction(async transaction => {
    const row = await HelpArticle.findByPk(req.valid.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw notFound("Tutorial");
    await row.destroy({ transaction }); // progress FK cascade; auditoria conserva somente ID e ação
    await audit({ actor: actorOf(req), action: "help.article.delete", entityType: "help_article", entityId: row.id, metadata: { slug: row.slug }, transaction });
  });
  res.json({ ok: true });
});
