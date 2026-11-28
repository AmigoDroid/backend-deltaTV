import { sequelize, PartnerServicePlan, ServicePlanCatalog } from "../../db/models/index.js";

export async function listCatalog({ includeInactive = true } = {}) {
  const where = {ownerAdminId:null, deletedAt:null, ...(includeInactive ? {} : {active:true})};
  const rows = await ServicePlanCatalog.findAll({ where, order: [["sortOrder", "ASC"], ["name", "ASC"]], raw: true });
  const counts = await PartnerServicePlan.findAll({
    attributes: ["tier", [sequelize.fn("COUNT", sequelize.col("partner_id")), "assignedCount"]],
    group: ["tier"], raw: true,
  });
  const byTier = new Map(counts.map(row => [row.tier, Number(row.assignedCount)]));
  return rows.map(r => ({ ...r, assignedCount: byTier.get(r.key) || 0 }));
}
