import { Op } from "sequelize";
import { Partner, ContentPartnerTerms, PartnerServicePlan } from "../../db/models/index.js";
import { defaultTier, featuresFor } from "../service-plans/plan.rules.js";

/** Resumo financeiro paginado: 3 consultas por página, sem N+1 nem carregar todos os parceiros. */
export async function contractOverview({ q = "", kind = "", page = 1, pageSize = 20 } = {}) {
  const size = Math.min(50, Math.max(1, Number(pageSize) || 20));
  const current = Math.max(1, Number(page) || 1);
  const where = { status: { [Op.ne]: "deleted" } };
  if (kind === "content" || kind === "reseller") where.kind = { [Op.in]: [kind, "both"] };
  if (q.trim()) {
    const search = q.trim().replace(/[\\%_]/g, "\\$&");
    where[Op.or] = [{ name: { [Op.iLike]: `%${search}%` } }, { slug: { [Op.iLike]: `%${search}%` } }];
  }
  const { count, rows } = await Partner.findAndCountAll({
    where,
    attributes: ["id", "name", "slug", "kind", "status", "billingModel", "monthlyFeeCents",
      "perDeviceCents", "minFeeCents", "tiers", "deviceLimit", "dueDay", "graceDays"],
    order: [["name", "ASC"], ["id", "ASC"]], offset: (current - 1) * size, limit: size, raw: true,
  });
  const ids = rows.map((row) => row.id);
  if (!ids.length) return { data: [], meta: { page: current, pageSize: size, total: count, totalPages: Math.ceil(count / size) } };
  const [terms, plans] = await Promise.all([
    ContentPartnerTerms.findAll({ where: { partnerId: { [Op.in]: ids } }, raw: true }),
    PartnerServicePlan.findAll({ where: { partnerId: { [Op.in]: ids } }, raw: true }),
  ]);
  const termsById = new Map(terms.map((t) => [t.partnerId, t]));
  const plansById = new Map(plans.map((p) => [p.partnerId, p]));
  return {
    data: rows.map((p) => {
      const terms = termsById.get(p.id);
      const service = plansById.get(p.id);
      const tier = service?.tier || defaultTier(p.kind);
      const features = featuresFor(tier, service || {});
      return {
        ...p,
        tier, features,
        contractMode: p.kind !== "reseller" ? (terms?.mode || "legacy") : null,
        fixedFeeCents: terms?.fixedFeeCents ?? null,
        activationLimit: terms?.activationLimit ?? null,
        creditsPerActivation: terms?.creditsPerActivation ?? null,
        licensePolicy: terms?.licensePolicy ?? null,
      };
    }),
    meta: { page: current, pageSize: size, total: count, totalPages: Math.ceil(count / size) },
  };
}
