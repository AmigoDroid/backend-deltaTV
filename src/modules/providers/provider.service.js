import { Op } from "sequelize";
import { sequelize, Partner, PartnerCode, PartnerProvider, Activation } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { probeAccount, xtreamOrigin } from "../xtream/xtream.service.js";
import { DEFAULT_TEMPLATE, buildPlaylistUrl, normalizeBaseUrl, validateTemplate } from "./playlist-url.js";
import { clearMirrorAuth } from "../mirror/mirror.cache.js";

/**
 * Confirma no painel do provedor (API Xtream, player_api.php) que usuário/senha existem e a conta está ativa.
 * Não baixa lista M3U: a resposta tem poucos KB (e o /get.php de vários painéis responde 404 de forma intermitente).
 * @returns {{ok:true}|{ok:false, reason:"invalid"|"unreachable"|"unverified"}}
 */
export async function probeCredentials(provider, credentials) {
  let baseUrl;
  try {
    baseUrl = xtreamOrigin(provider.baseUrl);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const r = await probeAccount({ baseUrl, ...credentials });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

/* ---------- Cadastro de provedores da parceria ---------- */

export const listProviders = (partnerId) =>
  PartnerProvider.findAll({ where: { partnerId }, order: [["priority", "ASC"], ["createdAt", "ASC"]] });

async function prepare(input, current) {
  const patch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.baseUrl !== undefined) {
    const origin = normalizeBaseUrl(input.baseUrl);
    await assertPublicUrl(origin); // SSRF: bloqueia IP privado/localhost/DNS interno
    patch.baseUrl = origin;
  }
  if (input.playlistTemplate !== undefined) patch.playlistTemplate = input.playlistTemplate;
  for (const k of ["deliveryMode", "priority", "status"]) if (input[k] !== undefined) patch[k] = input[k];
  validateTemplate(patch.playlistTemplate ?? current?.playlistTemplate ?? DEFAULT_TEMPLATE, patch.baseUrl ?? current?.baseUrl);
  return patch;
}

/** `max`: teto de servidores da parceria (usado no portal do revendedor, que cadastra os próprios). Admin não passa. */
export async function createProvider(partnerId, input, actor, { max } = {}) {
  if (!(await Partner.findByPk(partnerId))) throw notFound("Parceiro");
  if (max && (await PartnerProvider.count({ where: { partnerId } })) >= max) {
    throw new AppError(409, "PROVIDER_LIMIT", `Limite de ${max} servidores atingido. Exclua ou reaproveite um servidor existente.`);
  }
  const patch = await prepare({ playlistTemplate: DEFAULT_TEMPLATE, ...input });
  return sequelize.transaction(async (t) => {
    const p = await PartnerProvider.create({ partnerId, ...patch }, { transaction: t });
    await audit({ actor, action: "provider.create", entityType: "partner", entityId: partnerId, metadata: { providerId: p.id, baseUrl: p.baseUrl }, transaction: t });
    return p;
  });
}

export async function updateProvider(partnerId, id, input, actor) {
  const p = await PartnerProvider.findOne({ where: { id, partnerId } });
  if (!p) throw notFound("Provedor");
  const patch = await prepare(input, p);
  await p.update(patch);
  await audit({ actor, action: "provider.update", entityType: "partner", entityId: partnerId, metadata: { providerId: id, ...patch } });
  // Modo (proxy/redirect), URL base e status ficam em cache na rota espelho: sem isto a troca só vale após o TTL.
  clearMirrorAuth();
  return p;
}

export async function deleteProvider(partnerId, id, actor) {
  const p = await PartnerProvider.findOne({ where: { id, partnerId } });
  if (!p) throw notFound("Provedor");
  const used = await Activation.count({ where: { providerId: id, status: { [Op.ne]: "revoked" } } });
  if (used > 0) {
    throw new AppError(409, "PROVIDER_IN_USE", `${used} dispositivo(s) usam este provedor. Desative-o em vez de excluir.`);
  }
  // Códigos ativos apontando para este servidor: o admin precisa movê-los/revogá-los antes (senão ficariam sem destino).
  const codes = await PartnerCode.count({ where: { providerId: id, status: { [Op.ne]: "revoked" } } });
  if (codes > 0) {
    throw new AppError(409, "PROVIDER_HAS_CODES", `${codes} código(s) apontam para este servidor. Mova-os para outro servidor ou revogue-os antes de excluir.`);
  }
  await sequelize.transaction(async (t) => {
    // Códigos revogados só guardam histórico: soltam a referência para não travar a exclusão (FK).
    await PartnerCode.update({ providerId: null }, { where: { providerId: id }, transaction: t });
    await p.destroy({ transaction: t });
  });
  clearMirrorAuth();
  await audit({ actor, action: "provider.delete", entityType: "partner", entityId: partnerId, metadata: { providerId: id } });
}
