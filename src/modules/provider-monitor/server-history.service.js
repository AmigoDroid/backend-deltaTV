import { PartnerProvider, Partner, ProviderHealthEvent } from "../../db/models/index.js";
import { notFound } from "../../shared/errors.js";
import { pageOf, paged } from "../../shared/pagination.js";

/** Leitura administrativa da telemetria existente; não exige plano e não dispara sondagens. */
export async function getServerHistory(providerId, { page = 1, pageSize = 20, status } = {}) {
  const provider = await PartnerProvider.findByPk(providerId, {
    attributes: ["id", "name", "baseUrl", "partnerId"], include: [{ model: Partner, attributes: ["id", "name"], required: false }],
  });
  if (!provider) throw notFound("Servidor");
  const { rows, count } = await ProviderHealthEvent.findAndCountAll({
    where: { providerId: provider.id, ...(status ? { state: status } : {}) },
    attributes: ["id", "state", "latencyMs", "note", "occurredAt"],
    order: [["occurredAt", "DESC"], ["id", "DESC"]], ...pageOf({ page, pageSize }), raw: true,
  });
  return { provider: { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, partnerId: provider.partnerId, partnerName: provider.Partner?.name ?? null },
    ...paged(rows, count, { page, pageSize }) };
}
