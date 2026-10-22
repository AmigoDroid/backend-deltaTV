import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { AuditLog, AdminUser } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery, pageOf, paged } from "../../shared/pagination.js";
import { requirePermission } from "../../middleware/authenticate.js";

const router = Router();

router.get(
  "/", requirePermission("audit:read"),
  validate({ query: z.object({ ...pageQuery, action: z.string().max(80).optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(64).optional(), actorId: z.string().max(64).optional(), result: z.enum(["success", "failure", "denied"]).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  async (req, res) => {
    const q = req.valid.query;
    const where = {};
    if (q.action) where.action = { [Op.iLike]: `${q.action.replace(/[%_]/g, "")}%` };
    for (const k of ["entityType", "entityId", "actorId", "result"]) if (q[k]) where[k] = q[k];
    if (q.from || q.to) where.createdAt = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
    const { rows, count } = await AuditLog.findAndCountAll({ where, order: [["createdAt", "DESC"]], ...pageOf(q) });
    const ids = [...new Set(rows.filter((r) => ["admin", "partner"].includes(r.actorType) && r.actorId).map((r) => r.actorId))];
    const users = ids.length ? await AdminUser.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name", "email"] }) : [];
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    res.json(paged(rows.map((r) => ({ ...r.toJSON(), actorName: byId[r.actorId]?.name ?? null })), count, q));
  },
);

export default router;
