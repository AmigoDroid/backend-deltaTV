import { Op } from "sequelize";
import {
  sequelize,
  ContentSource,
  Category,
  Channel,
  Partner,
  PartnerSource,
  PartnerProvider,
} from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { encryptSecret, decryptSecret } from "../../shared/crypto.js";
import { assertPublicUrl } from "../../shared/ssrf.js";
import { pageOf, paged } from "../../shared/pagination.js";


const publicSource = (s) => {
  const j = s.toJSON();

  delete j.urlEnc;

  j.signing = {
    type: j.signing?.type ?? "none",
    ttlSeconds: j.signing?.ttlSeconds ?? null,
    hasSecret: !!j.signing?.secretEnc,
  };

  return j;
};

function buildSigning(input, previous) {
  if (!input) return previous ?? {};

  const { secret, ...rest } = input;

  if (rest.type === "none") {
    return { type: "none" };
  }

  const secretEnc = secret ? encryptSecret(secret) : previous?.secretEnc;

  if (!secretEnc) {
    throw new AppError(
      422,
      "SECRET_REQUIRED",
      "Informe o segredo de assinatura.",
    );
  }

  return { ...rest, secretEnc };
}

/* ---------- Fontes (admin) ---------- */

export async function listSources({ q, scope, status, page, pageSize }) {
  const where = {};

  if (scope) where.scope = scope;
  if (status) where.status = status;
  if (q) where.name = { [Op.iLike]: `%${q}%` };

  const { rows, count } = await ContentSource.findAndCountAll({
    where,
    include: [
      {
        model: Partner,
        attributes: ["id", "name"],
        through: { attributes: [] },
      },
    ],
    order: [["name", "ASC"]],
    ...pageOf({ page, pageSize }),
    distinct: true,
  });

  return paged(rows.map(publicSource), count, {
    page,
    pageSize,
  });
}

export async function getSource(id) {
  const s = await ContentSource.findByPk(id, {
    include: [
      {
        model: Partner,
        attributes: ["id", "name"],
        through: { attributes: [] },
      },
    ],
  });

  if (!s) throw notFound("Fonte");

  return publicSource(s);
}

export async function createSource(input, actor) {
  let urlEnc = null;
  let host = null;

  if (input.url) {
    const url = await assertPublicUrl(input.url);

    urlEnc = encryptSecret(url.href);
    host = url.hostname;
  }

  return sequelize.transaction(async (t) => {
    const s = await ContentSource.create(
      {
        name: input.name,
        kind: input.kind,
        scope: input.scope,
        urlEnc,
        host,
        deliveryMode: input.deliveryMode,
        signing: buildSigning(input.signing),
        notes: input.notes ?? null,
        createdBy: actor.id,
      },
      { transaction: t },
    );

    await audit({
      actor,
      action: "source.create",
      entityType: "source",
      entityId: s.id,
      metadata: { name: s.name, host },
      transaction: t,
    });

    return publicSource(s);
  });
}

export async function updateSource(id, input, actor) {
  const s = await ContentSource.findByPk(id);

  if (!s) throw notFound("Fonte");

  const patch = {};

  for (const k of ["name", "scope", "deliveryMode", "status", "notes"]) {
    if (input[k] !== undefined) {
      patch[k] = input[k];
    }
  }

  if (input.url) {
    const url = await assertPublicUrl(input.url);

    patch.urlEnc = encryptSecret(url.href);
    patch.host = url.hostname;
  }

  if (input.signing) {
    patch.signing = buildSigning(input.signing, s.signing);
  }

  await s.update(patch);


  await audit({
    actor,
    action: "source.update",
    entityType: "source",
    entityId: id,
    metadata: { ...patch, urlEnc: undefined },
  });

  return publicSource(s);
}

export async function deleteSource(id, actor) {
  const n = await ContentSource.destroy({
    where: { id },
  });

  if (!n) throw notFound("Fonte");


  await audit({
    actor,
    action: "source.delete",
    entityType: "source",
    entityId: id,
  });
}

export async function setSourcePartners(id, partnerIds, actor) {
  return sequelize.transaction(async (t) => {
    const s = await ContentSource.findByPk(id, {
      transaction: t,
    });

    if (!s) throw notFound("Fonte");

    if (s.scope === "global" && partnerIds.length) {
      throw new AppError(
        422,
        "SCOPE_MISMATCH",
        "Fontes globais não são vinculadas a parceiros.",
      );
    }

    const found = await Partner.count({
      where: {
        id: { [Op.in]: partnerIds },
      },
      transaction: t,
    });

    if (found !== new Set(partnerIds).size) {
      throw new AppError(
        422,
        "INVALID_PARTNER",
        "Parceiro inexistente na lista.",
      );
    }

    await PartnerSource.destroy({
      where: { sourceId: id },
      transaction: t,
    });

    await PartnerSource.bulkCreate(
      partnerIds.map((partnerId) => ({
        partnerId,
        sourceId: id,
      })),
      { transaction: t },
    );

    await audit({
      actor,
      action: "source.partners",
      entityType: "source",
      entityId: id,
      metadata: { partnerIds },
      transaction: t,
    });
  });
}

/* ---------- Categorias e canais (admin) ---------- */

export const listCategories = (sourceId) =>
  Category.findAll({
    where: { sourceId },
    order: [
      ["sortOrder", "ASC"],
      ["name", "ASC"],
    ],
  });

export const createCategory = (sourceId, data) =>
  Category.create({ sourceId, ...data });

export async function updateCategory(sourceId, id, data) {
  const c = await Category.findOne({
    where: { id, sourceId },
  });

  if (!c) throw notFound("Categoria");

  return c.update(data);
}

export async function deleteCategory(sourceId, id) {
  const deleted = await Category.destroy({
    where: { id, sourceId },
  });

  if (!deleted) throw notFound("Categoria");
}

const channelOut = (c) => {
  const j = c.toJSON();

  delete j.streamUrlEnc;

  return j;
};

export async function listChannels(sourceId, { q, page, pageSize }) {
  const where = { sourceId };

  if (q) {
    where.name = { [Op.iLike]: `%${q}%` };
  }

  const { rows, count } = await Channel.findAndCountAll({
    where,
    include: [Category],
    order: [
      ["sortOrder", "ASC"],
      ["name", "ASC"],
    ],
    ...pageOf({ page, pageSize }),
  });

  return paged(rows.map(channelOut), count, {
    page,
    pageSize,
  });
}

export async function createChannel(sourceId, { streamUrl, ...data }, actor) {
  const s = await ContentSource.findByPk(sourceId);

  if (!s) throw notFound("Fonte");

  const url = await assertPublicUrl(streamUrl);

  const c = await Channel.create({
    sourceId,
    ...data,
    streamUrlEnc: encryptSecret(url.href),
  });

  await audit({
    actor,
    action: "channel.create",
    entityType: "channel",
    entityId: c.id,
    metadata: { sourceId, name: c.name },
  });

  return channelOut(c);
}

export async function updateChannel(
  sourceId,
  id,
  { streamUrl, ...data },
  actor,
) {
  const c = await Channel.findOne({
    where: { id, sourceId },
  });

  if (!c) throw notFound("Canal");

  const patch = { ...data };

  if (streamUrl) {
    patch.streamUrlEnc = encryptSecret((await assertPublicUrl(streamUrl)).href);
  }

  await c.update(patch);

  await audit({
    actor,
    action: "channel.update",
    entityType: "channel",
    entityId: id,
  });

  return channelOut(c);
}

export async function deleteChannel(sourceId, id, actor) {
  const deleted = await Channel.destroy({
    where: { id, sourceId },
  });

  if (!deleted) throw notFound("Canal");

  await audit({
    actor,
    action: "channel.delete",
    entityType: "channel",
    entityId: id,
  });
}

/* ---------- Lado do cliente ---------- */

/**
 * Fontes que ESTE dispositivo pode usar:
 * individuais -> globais;
 * parceria -> fontes vinculadas ao parceiro.
 */
export async function allowedSources(activation) {
  if (activation.licenseId) {
    return ContentSource.findAll({
      where: {
        scope: "global",
        status: "active",
      },
      order: [["name", "ASC"]],
    });
  }

  return ContentSource.findAll({
    where: {
      scope: "partner",
      status: "active",
    },
    include: [
      {
        model: Partner,
        where: { id: activation.partnerId },
        attributes: [],
        through: { attributes: [] },
        required: true,
      },
    ],
    order: [["name", "ASC"]],
  });
}

export async function getAllowedSource(activation, sourceId) {
  const list = await allowedSources(activation);
  const s = list.find((x) => x.id === sourceId);

  if (!s) throw notFound("Fonte");

  return s;
}
