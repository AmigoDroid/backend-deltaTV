import { AppError } from "../../shared/errors.js";
import { env } from "../../config/env.js";
import { xtreamCall, playUrlFor } from "./xtream.client.js";

/**
 * Catálogo sob demanda a partir da API Xtream. Devolve os MESMOS formatos de query.service.js (pastas, itens,
 * séries, temporadas, episódios), para os clientes (Roku, web, Android, Samsung, LG) não precisarem mudar.
 *
 * Ids (opacos para o cliente):
 *   pasta     xg_<category_id>          canal  xl<stream_id>
 *   filme     xm<stream_id>             série  xs<series_id>      episódio xe<episode_id>
 *
 * Paginação: a pasta inteira vem do provedor em uma resposta pequena (cache) e é fatiada por deslocamento (cursor).
 */

const PAGE = { default: 40, max: 100 };
const KINDS = ["live", "movie", "series"];
const ID_RE = /^x([lmes])(\d{1,12})$/;
const GROUP_RE = /^xg_(\d{1,10})$/;

export const isXtreamId = (v) => typeof v === "string" && ID_RE.test(v);
export const isXtreamSeriesId = (v) => typeof v === "string" && /^xs\d{1,12}$/.test(v);

const bad = (msg) => new AppError(400, "VALIDATION_ERROR", msg);
const ttl = () => ({ ttlSeconds: env.xtreamCacheTtlSeconds });
const ttlLong = () => ({ ttlSeconds: env.xtreamCategoryTtlSeconds });
const arr = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (v == null ? "" : String(v));
const num = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const clampPageSize = (n) => {
  const v = Number.parseInt(n ?? PAGE.default, 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), PAGE.max) : PAGE.default;
};

const encodeCursor = (o) => Buffer.from(JSON.stringify({ o }), "utf8").toString("base64url");
function decodeCursor(raw) {
  if (!raw) return 0;
  try {
    const c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (!Number.isInteger(c?.o) || c.o < 0) throw new Error("shape");
    return c.o;
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Cursor inválido. Recomece a navegação.");
  }
}

const fold = (s) => text(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const matches = (title, q) => !q || fold(title).includes(fold(q));
const meta = () => ({ catalogVersion: "xtream", latestVersion: "xtream", outdated: false });

const ACTION = {
  live: { cats: "get_live_categories", list: "get_live_streams" },
  movie: { cats: "get_vod_categories", list: "get_vod_streams" },
  series: { cats: "get_series_categories", list: "get_series" },
};

function categoryOf(groupId) {
  const m = typeof groupId === "string" ? groupId.match(GROUP_RE) : null;
  if (!m) throw bad("groupId inválido.");
  return m[1];
}

function page(rows, cursor, size) {
  const start = decodeCursor(cursor);
  const slice = rows.slice(start, start + size);
  const next = start + size < rows.length ? encodeCursor(start + size) : null;
  return { slice, next };
}

const liveItem = (r) => ({
  id: `xl${r.stream_id}`, kind: "live", title: text(r.name) || "Sem título", logo: text(r.stream_icon) || null,
  groupId: `xg_${text(r.category_id)}`, ext: ".m3u8",
  ...(r.epg_channel_id ? { tvgId: text(r.epg_channel_id) } : {}),
});

const movieItem = (r) => ({
  id: `xm${r.stream_id}`, kind: "movie", title: text(r.name) || text(r.title) || "Sem título", logo: text(r.stream_icon) || null,
  groupId: `xg_${text(r.category_id)}`, ext: `.${text(r.container_extension) || "mp4"}`,
});

const episodeItem = (e, seriesId, season) => ({
  id: `xe${e.id}`, kind: "series", title: text(e.title) || `Episódio ${text(e.episode_num)}`,
  logo: text(e.info?.movie_image) || null, groupId: null, ext: `.${text(e.container_extension) || "mp4"}`,
  seriesId, season, episode: num(e.episode_num), episodeTitle: text(e.title) || null,
});

/* ---------- Consultas (mesmos nomes e formatos de query.service.js) ---------- */

/** Pastas. O painel não informa a contagem de itens por pasta: itemCount vai como null. */
export async function listGroups({ account, kind }) {
  if (!KINDS.includes(kind)) throw bad("kind inválido.");
  const rows = arr(await xtreamCall(account, { action: ACTION[kind].cats }, ttlLong()));
  return {
    groups: rows.filter((c) => c?.category_id != null).map((c) => ({ id: `xg_${c.category_id}`, name: text(c.category_name) || "Sem categoria", itemCount: null })),
    ...meta(),
  };
}

export async function listItems({ account, kind, groupId, cursor, pageSize, q }) {
  if (!KINDS.includes(kind) || kind === "series") throw bad("kind deve ser live ou movie.");
  if (kind === "live" && !groupId) throw bad("Informe a pasta (groupId) para listar os canais.");
  if (!groupId && !q) throw bad("Informe a pasta (groupId) ou um termo de pesquisa (q).");
  if (!groupId && kind === "movie") throw bad("A pesquisa de filmes exige a pasta (groupId).");
  const params = { action: ACTION[kind].list };
  if (groupId) params.category_id = categoryOf(groupId);
  const rows = arr(await xtreamCall(account, params, ttl()))
    .filter((r) => r?.stream_id != null && matches(r.name ?? r.title, q));
  const { slice, next } = page(rows, cursor, clampPageSize(pageSize));
  return { items: slice.map(kind === "live" ? liveItem : movieItem), nextCursor: next, ...meta() };
}

export async function listSeries({ account, groupId, cursor, pageSize, q }) {
  if (!groupId) throw bad("Informe a pasta (groupId) das séries.");
  const rows = arr(await xtreamCall(account, { action: ACTION.series.list, category_id: categoryOf(groupId) }, ttl()))
    .filter((r) => r?.series_id != null && matches(r.name ?? r.title, q));
  const { slice, next } = page(rows, cursor, clampPageSize(pageSize));
  return {
    series: slice.map((s) => ({
      id: `xs${s.series_id}`, title: text(s.name) || text(s.title) || "Sem título", logo: text(s.cover) || null,
      groupId: `xg_${text(s.category_id) || categoryOf(groupId)}`, seasonCount: null, episodeCount: null,
    })),
    nextCursor: next, ...meta(),
  };
}

/** Episódios agrupados por temporada, a partir de get_series_info. */
async function seriesEpisodes(account, seriesId) {
  const m = seriesId.match(/^xs(\d{1,12})$/);
  if (!m) throw bad("seriesId inválido.");
  const info = await xtreamCall(account, { action: "get_series_info", series_id: m[1] }, ttl());
  const eps = info?.episodes;
  const flat = [];
  if (Array.isArray(eps)) {
    for (const e of eps.flat()) if (e?.id != null) flat.push({ e, season: num(e.season) ?? 1 });
  } else if (eps && typeof eps === "object") {
    for (const [key, list] of Object.entries(eps)) {
      for (const e of arr(list)) if (e?.id != null) flat.push({ e, season: num(e.season) ?? num(key) ?? 1 });
    }
  }
  if (!flat.length && !info?.info) throw new AppError(404, "NOT_FOUND", "Série não encontrada.");
  flat.sort((a, b) => a.season - b.season || (num(a.e.episode_num) ?? 1e9) - (num(b.e.episode_num) ?? 1e9));
  return flat;
}

export async function listSeasons({ account, seriesId }) {
  if (!seriesId) throw bad("seriesId é obrigatório.");
  const flat = await seriesEpisodes(account, seriesId);
  const counts = new Map();
  for (const { season } of flat) counts.set(season, (counts.get(season) ?? 0) + 1);
  return { seasons: [...counts].map(([season, episodeCount]) => ({ season, episodeCount })), ...meta() };
}

export async function listEpisodes({ account, seriesId, season, cursor, pageSize }) {
  if (!seriesId) throw bad("seriesId é obrigatório.");
  const flat = (await seriesEpisodes(account, seriesId)).filter((x) => season == null || x.season === season);
  const { slice, next } = page(flat, cursor, clampPageSize(pageSize));
  return { episodes: slice.map(({ e, season: s }) => episodeItem(e, seriesId, s)), nextCursor: next, ...meta() };
}

/** Metadados de um item. Canal: do cache da lista; filme: get_vod_info; episódio: só o id (o painel não o consulta isolado). */
export async function getItem({ account, id }) {
  const m = typeof id === "string" ? id.match(ID_RE) : null;
  if (!m) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  const [, t, raw] = m;
  if (t === "l") {
    const row = arr(await xtreamCall(account, { action: ACTION.live.list }, ttl())).find((r) => String(r?.stream_id) === raw);
    if (!row) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    return { item: liveItem(row), ...meta() };
  }
  if (t === "m") {
    const info = await xtreamCall(account, { action: "get_vod_info", vod_id: raw }, ttl());
    const d = info?.info;
    const mv = info?.movie_data;
    if (!mv && !d) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
    return {
      item: movieItem({ stream_id: raw, name: mv?.name ?? d?.name, stream_icon: d?.movie_image, category_id: mv?.category_id, container_extension: mv?.container_extension }),
      ...meta(),
    };
  }
  return { item: { id, kind: "series", title: "", logo: null, groupId: null, ext: "" }, ...meta() };
}

/** Para o gateway de reprodução: monta a URL de origem (com credenciais, só no servidor). `hint` = extensão pedida. */
export async function resolvePlayable({ account, id, hint }) {
  const m = typeof id === "string" ? id.match(ID_RE) : null;
  if (!m || m[1] === "s") return null;
  const kind = { l: "live", m: "movie", e: "series" }[m[1]];
  return { kind, origin: await playUrlFor(account, { kind, id: m[2], ext: hint }) };
}
