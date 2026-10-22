import { AppError } from "../../shared/errors.js";

/**
 * Consultas paginadas do catálogo para os clientes (Roku, web, Android, Samsung, LG).
 *
 * - O ESCOPO (qual lista o cliente enxerga) é decidido pelo chamador a partir da sessão/ativação autenticada,
 *   nunca por parâmetro da requisição. Aqui o escopo já chega resolvido.
 * - Nenhuma resposta contém URL de origem nem credenciais: só metadados. A reprodução passa pelo gateway.
 * - Paginação por cursor (keyset) sobre uma VERSÃO fixa do catálogo. Se uma nova versão for publicada no meio da
 *   navegação, o cursor continua servindo a versão antiga (enquanto existir); depois de limpa, responde 409 e o
 *   cliente recomeça da primeira página.
 */

export const PAGE = Object.freeze({ default: 40, max: 100 });
export const KINDS = Object.freeze(["live", "movie", "series"]);

export const isUuid = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export const clampPageSize = (n) => {
  const v = Number.parseInt(n ?? PAGE.default, 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, 1), PAGE.max) : PAGE.default;
};

export const encodeCursor = (c) => Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
export function decodeCursor(raw) {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(String(raw), "base64url").toString("utf8"));
    if (!isUuid(c?.v) || !Number.isInteger(c.s) || c.s < 0 || (c.e !== undefined && !Number.isInteger(c.e))) throw new Error("shape");
    return c;
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Cursor inválido. Recomece a navegação.");
  }
}

/** Escolhe a versão a servir: a do cursor (se ainda existir e for do mesmo escopo) ou a ativa. */
async function resolveVersion(repo, scope, cursor) {
  const active = await repo.activeImport(scope);
  if (!active) throw new AppError(503, "CATALOG_PREPARING", "O catálogo ainda está sendo preparado. Tente novamente em instantes.");
  if (!cursor || cursor.v === active.id) return { version: active, active };
  const older = await repo.importInScope(cursor.v, scope);
  if (!older || !["ready", "superseded"].includes(older.status)) {
    throw new AppError(409, "CATALOG_VERSION_GONE", "O catálogo foi atualizado. Recarregue a lista.");
  }
  return { version: older, active };
}

const meta = (version, active) => ({ catalogVersion: version.id, latestVersion: active.id, outdated: version.id !== active.id });

const publicItem = (r) => ({
  id: r.id, kind: r.kind, title: r.title, logo: r.logo || null, groupId: r.groupId, ext: r.ext || "",
  ...(r.tvgId ? { tvgId: r.tvgId } : {}),
  ...(r.seriesId ? { seriesId: r.seriesId, season: r.season, episode: r.episode, episodeTitle: r.episodeTitle } : {}),
});

const need = (cond, msg) => { if (!cond) throw new AppError(400, "VALIDATION_ERROR", msg); };

/** Pastas de um tipo (live | movie | series), na ordem original do M3U, com a contagem de itens. */
export async function listGroups({ repo, scope, kind }) {
  need(KINDS.includes(kind), "kind inválido.");
  const active = await repo.activeImport(scope);
  if (!active) throw new AppError(503, "CATALOG_PREPARING", "O catálogo ainda está sendo preparado. Tente novamente em instantes.");
  const rows = await repo.listGroups(active.id, kind);
  return { groups: rows.map((g) => ({ id: g.id, name: g.name, itemCount: g.itemCount })), ...meta(active, active) };
}

/** Itens (canais/filmes) de uma pasta, paginados. `groupId` é obrigatório para live. */
export async function listItems({ repo, scope, kind, groupId, cursor, pageSize, q }) {
  need(KINDS.includes(kind) && kind !== "series", "kind deve ser live ou movie.");
  need(kind !== "live" || groupId, "Informe a pasta (groupId) para listar os canais.");
  need(groupId || q, "Informe a pasta (groupId) ou um termo de pesquisa (q).");
  const size = clampPageSize(pageSize);
  const cur = decodeCursor(cursor);
  const { version, active } = await resolveVersion(repo, scope, cur);
  const rows = await repo.listItems(version.id, { kind, groupId, afterSeq: cur?.s ?? 0, limit: size + 1, q });
  const page = rows.slice(0, size);
  const next = rows.length > size ? encodeCursor({ v: version.id, s: page.at(-1).seq }) : null;
  return { items: page.map(publicItem), nextCursor: next, ...meta(version, active) };
}

export async function listSeries({ repo, scope, groupId, cursor, pageSize, q }) {
  const size = clampPageSize(pageSize);
  const cur = decodeCursor(cursor);
  const { version, active } = await resolveVersion(repo, scope, cur);
  const rows = await repo.listSeries(version.id, { groupId, afterSeq: cur?.s ?? 0, limit: size + 1, q });
  const page = rows.slice(0, size);
  const next = rows.length > size ? encodeCursor({ v: version.id, s: page.at(-1).seq }) : null;
  return {
    series: page.map((s) => ({ id: s.id, title: s.title, logo: s.logo || null, groupId: s.groupId, seasonCount: s.seasonCount, episodeCount: s.episodeCount })),
    nextCursor: next, ...meta(version, active),
  };
}

export async function listSeasons({ repo, scope, seriesId }) {
  need(seriesId, "seriesId é obrigatório.");
  const active = await repo.activeImport(scope);
  if (!active) throw new AppError(503, "CATALOG_PREPARING", "O catálogo ainda está sendo preparado. Tente novamente em instantes.");
  const rows = await repo.listSeasons(active.id, seriesId);
  if (!rows.length) throw new AppError(404, "NOT_FOUND", "Série não encontrada.");
  return { seasons: rows.map((r) => ({ season: r.season, episodeCount: r.episodeCount })), ...meta(active, active) };
}

export async function listEpisodes({ repo, scope, seriesId, season, cursor, pageSize }) {
  need(seriesId, "seriesId é obrigatório.");
  const size = clampPageSize(pageSize);
  const cur = decodeCursor(cursor);
  const { version, active } = await resolveVersion(repo, scope, cur);
  const rows = await repo.listEpisodes(version.id, { seriesId, season: season ?? null, after: cur ? { e: cur.e ?? 0, s: cur.s } : null, limit: size + 1 });
  const page = rows.slice(0, size);
  const last = page.at(-1);
  const next = rows.length > size ? encodeCursor({ v: version.id, s: last.seq, e: last.episode ?? EPISODE_NULL }) : null;
  return { episodes: page.map(publicItem), nextCursor: next, ...meta(version, active) };
}

/** Valor usado no cursor para episódio sem número (ordena depois dos numerados). */
export const EPISODE_NULL = 2_147_483_647;

/** Metadados de um item da versão ativa (ids são estáveis entre versões). Nunca devolve a origem. */
export async function getItem({ repo, scope, id }) {
  const active = await repo.activeImport(scope);
  if (!active) throw new AppError(503, "CATALOG_PREPARING", "O catálogo ainda está sendo preparado. Tente novamente em instantes.");
  const row = isUuid(id) ? await repo.getItem(active.id, id) : null;
  if (!row) throw new AppError(404, "NOT_FOUND", "Item não encontrado.");
  return { item: publicItem(row), ...meta(active, active) };
}

/** Para o gateway de reprodução: devolve a origem CIFRADA do item na versão ativa (quem chama decifra e autoriza). */
export async function resolvePlayable({ repo, scope, id }) {
  if (!isUuid(id)) return null;
  const active = await repo.activeImport(scope);
  if (!active) return null;
  const row = await repo.getItem(active.id, id);
  return row ? { id: row.id, kind: row.kind, originEnc: row.originEnc } : null;
}
