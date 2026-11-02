import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { LoginHistory } from "../../db/models/index.js";
import { authenticate } from "../../middleware/authenticate.js";
import { validate } from "../../shared/validate.js";
import { AppError } from "../../shared/errors.js";

const router = Router();
router.use(authenticate);
router.get("/", validate({ query: z.object({
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
  userId: z.string().uuid().optional(), outcome: z.enum(["success", "failure"]).optional(),
}) }), async (req, res) => {
  const { page, limit, userId, outcome } = req.valid.query;
  const where = {};
  if (req.user.role === "partner") where.adminUserId = req.user.id;
  else if (req.user.role === "superadmin") { if (userId) where.adminUserId = userId; }
  else throw new AppError(403, "FORBIDDEN", "Histórico restrito ao superadmin e ao titular da conta.");
  if (outcome) where.outcome = outcome;
  const { count, rows } = await LoginHistory.findAndCountAll({ where, limit, offset: (page - 1) * limit, order: [["createdAt", "DESC"]] });
  res.json({ data: rows, meta: { page, limit, total: count, pages: Math.ceil(count / limit) } });
});
export default router;
