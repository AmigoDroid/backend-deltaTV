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
import { assertPublicUrl, safeGet } from "../../shared/ssrf.js";
import { pageOf, paged } from "../../shared/pagination.js";
import M3UService from "./m3u.service.js";
import { signOriginUrl } from "./signing.js";
import { env } from "../../config/env.js";
import { buildPlaylistUrl } from "../providers/playlist-url.js";

// PLAYLIST_MAX_MB no .env (0 = sem limite). A playlist é processada em stream; só os itens ficam em memória.
const MAX_PLAYLIST_BYTES =
  env.playlistMaxBytes > 0 ? env.playlistMaxBytes : Infinity;
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // sourceId -> { items, at }
const PERSONAL_CACHE_PREFIX = "act:";

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

  cache.delete(id);

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

  cache.delete(id);

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

// Entrega os pedaços da resposta respeitando o limite (se houver), sem juntá-los em memória.
async function* limitedChunks(res, limit) {
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) {
      res.destroy();
      throw new AppError(
        502,
        "ORIGIN_TOO_LARGE",
        "Playlist da origem excede o tamanho máximo.",
      );
    }
    yield chunk;
  }
}

async function fetchM3U(url) {
  const res = await safeGet(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (IPTV-Licensing)",
    },
    timeoutMs: 20000,
  });

  if (res.statusCode !== 200) {
    res.resume();

    throw new AppError(
      502,
      "ORIGIN_ERROR",
      "A origem não respondeu corretamente.",
    );
  }

  const contentLength = Number(res.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_PLAYLIST_BYTES) {
    res.destroy();
    throw new AppError(
      502,
      "ORIGIN_TOO_LARGE",
      "Playlist da origem excede o tamanho máximo.",
    );
  }
  // O Content-Type enviado por provedores IPTV é pouco confiável (text/html, force-download,
  // x-m3u...): quem valida é o parser, que exige o cabeçalho #EXTM3U no início do arquivo.
  // Lê em stream: o texto da playlist nunca é montado inteiro em memória.
  try {
    return await M3UService.parseStream(limitedChunks(res, MAX_PLAYLIST_BYTES));
  } catch (e) {
    if (e?.code === "INVALID_M3U") {
      throw new AppError(
        502,
        "ORIGIN_INVALID_PLAYLIST",
        "A origem não retornou uma playlist M3U válida.",
      );
    }
    throw e;
  }
}

async function loadPlaylist(source) {
  const hit = cache.get(source.id);

  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.items;
  }

  const items = await fetchM3U(decryptSecret(source.urlEnc));

  cache.set(source.id, {
    items,
    at: Date.now(),
  });

  return items;
}

/* ---------- Playlist do próprio cliente ---------- */

/**
 * ID virtual usado em /play/me/...
 */
export const PERSONAL = "me";

async function providerOf(activation) {
  const provider = activation.providerId
    ? await PartnerProvider.findByPk(activation.providerId)
    : null;

  if (!provider || provider.status !== "active" || !activation.credentialsEnc) {
    throw new AppError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Serviço indisponível. Contate seu fornecedor.",
    );
  }

  return provider;
}

async function loadPersonalPlaylist(activation) {
  const key = `act:${activation.id}`;
  const hit = cache.get(key);

  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.items;
  }

  if (activation.playlistUrlEnc) {
    const items = await fetchM3U(decryptSecret(activation.playlistUrlEnc));
    cache.set(key, { items, at: Date.now() });
    return items;
  }

  const provider = await providerOf(activation);
  const credentials = JSON.parse(decryptSecret(activation.credentialsEnc));

  const items = await fetchM3U(
    buildPlaylistUrl(provider.baseUrl, provider.playlistTemplate, credentials),
  );

  cache.set(key, {
    items,
    at: Date.now(),
  });

  return items;
}

export const hasPersonalPlaylist = (activation) =>
  !!(activation.providerId || activation.playlistUrlEnc);

export function clearPersonalCatalog(activationId) {
  cache.delete(`${PERSONAL_CACHE_PREFIX}${activationId}`);
}

export async function buildPersonalCatalog(activation) {
  const items = await loadPersonalPlaylist(activation);
  if (!activation.playlistUrlEnc) await providerOf(activation);

  return items.map((it, i) => {
    const { srcVideo, ...rest } = it;

    return {
      id: `p${i}`,
      ...rest,

      // A playlist pessoal pode conter credenciais do provedor nos URLs de mídia.
      srcVideo: playPath(PERSONAL, `p${i}`, srcVideo),
    };
  });
}

// Devolve { origin, deliveryMode } do item da playlist pessoal.
export async function resolvePersonalOrigin(activation, ref) {
  if (!/^p\d{1,7}$/.test(ref)) {
    throw notFound("Item");
  }

  const item = (await loadPersonalPlaylist(activation))[Number(ref.slice(1))];

  if (!item) throw notFound("Item");

  if (activation.playlistUrlEnc) {
    return { origin: item.srcVideo, deliveryMode: "proxy" };
  }

  await providerOf(activation);
  return {
    origin: item.srcVideo,
    deliveryMode: "proxy",
  };
}

const playPath = (sourceId, ref, originUrl) => {
  let ext = "";

  try {
    ext =
      new URL(originUrl).pathname
        .match(/\.(m3u8|ts|mp4|mkv|webm|mp3|aac)$/i)?.[0]
        .toLowerCase() ?? "";
  } catch {
    // URL inválida: sem extensão.
  }

  return `/api/v1/play/${sourceId}/${ref}${ext}`;
};

/* ---------- Catálogo das fontes ---------- */

export async function buildCatalog(source) {
  if (source.kind === "playlist") {
    const items = await loadPlaylist(source);

    return items.map((it, i) => {
      const { srcVideo, ...rest } = it;

      // Aplica assinatura quando configurada.
      const originUrl = signedOrigin(source, srcVideo);

      return {
        id: `p${i}`,
        ...rest,

        // redirect: URL original (com assinatura, se configurada).
        // proxy: caminho interno da API.
        srcVideo:
          source.deliveryMode === "redirect"
            ? originUrl
            : playPath(source.id, `p${i}`, originUrl),
      };
    });
  }

  const channels = await Channel.findAll({
    where: {
      sourceId: source.id,
      status: "active",
    },
    include: [Category],
    order: [
      ["sortOrder", "ASC"],
      ["name", "ASC"],
    ],
  });

  const typeOf = {
    live: "canais",
    movie: "filmes",
    series: "series",
  };

  return channels.map((c) => {
    const originUrl = signedOrigin(source, decryptSecret(c.streamUrlEnc));

    return {
      id: `c${c.id}`,
      title: c.name,
      group: c.Category?.name ?? "Sem categoria",
      type: typeOf[c.kind] ?? "canais",
      srcImage: c.logoUrl ?? "",

      // redirect: URL original da fonte.
      // proxy: caminho interno da API.
      srcVideo:
        source.deliveryMode === "redirect"
          ? originUrl
          : playPath(source.id, `c${c.id}`, originUrl),
    };
  });
}

export async function resolveOrigin(source, ref) {
  if (/^p\d{1,7}$/.test(ref) && source.kind === "playlist") {
    const items = await loadPlaylist(source);
    const item = items[Number(ref.slice(1))];

    if (!item) throw notFound("Item");

    return item.srcVideo;
  }

  const m = ref.match(/^c([0-9a-f-]{36})$/);

  if (m && source.kind === "catalog") {
    const c = await Channel.findOne({
      where: {
        id: m[1],
        sourceId: source.id,
        status: "active",
      },
    });

    if (!c) throw notFound("Canal");

    return decryptSecret(c.streamUrlEnc);
  }

  throw notFound("Item");
}

export const signedOrigin = (source, originUrl) =>
  source.signing?.type && source.signing.type !== "none"
    ? signOriginUrl(
        originUrl,
        source.signing,
        decryptSecret(source.signing.secretEnc),
      )
    : originUrl;
