import { QueryTypes } from "sequelize";
import { AppError } from "../../shared/errors.js";

/**
 * Repositório PostgreSQL do catálogo (contrato idêntico ao de tests/helpers/memory-catalog-repo.js).
 * NÃO VALIDADO contra um banco neste ambiente: rode `npm run verify:db` e os testes de integração do catálogo.
 *
 * Segurança: nomes de coluna só vêm da lista fixa abaixo; todo valor vai por parâmetro (replacements).
 */
const COL = { source: "source_id", activation: "activation_id" };
const colOf = (scope) => {
  const c = COL[scope?.type];
  if (!c) throw new Error("escopo de catálogo inválido");
  return c;
};

// Limites das colunas varchar e remoção de NUL (o PostgreSQL rejeita \u0000 em texto).
const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).replace(/\u0000/g, "");
  return max ? s.slice(0, max) : s;
};
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
const likeOf = (q) => `%${String(q).replace(/[\\%_]/g, "\\$&")}%`;

export function createPgCatalogRepo(sequelize) {
  const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT, transaction });
  const exec = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction });

  return {
    async beginImport({ scope, lockedBy, lockTtlMs, now }) {
      const col = colOf(scope);
      // Importação interrompida (instância caiu): a trava vence e é marcada como falha.
      await exec(
        `UPDATE catalog_imports SET status = 'failed', error_code = 'STALE_LOCK', error_message = 'Importação anterior interrompida.', finished_at = :now, updated_at = :now
          WHERE ${col} = :id AND status IN ('queued','running') AND lock_expires_at < :now`,
        { id: scope.id, now },
      );
      const [prev] = await select(`SELECT id, item_count AS "itemCount" FROM catalog_imports WHERE ${col} = :id AND is_active LIMIT 1`, { id: scope.id });
      try {
        const [row] = await select(
          `INSERT INTO catalog_imports (${col}, status, locked_by, lock_expires_at, started_at)
           VALUES (:id, 'running', :by, :exp, :now) RETURNING id`,
          { id: scope.id, by: lockedBy, exp: new Date(now.getTime() + lockTtlMs), now },
        );
        return { importId: row.id, previous: prev ?? null };
      } catch (e) {
        // Índice parcial único (uma importação em andamento por escopo): coordenação entre instâncias.
        if (e?.original?.code === "23505" || e?.parent?.code === "23505") throw new AppError(409, "IMPORT_IN_PROGRESS", "Já existe uma importação em andamento.");
        throw e;
      }
    },

    async loadFingerprints(importId) {
      return select(`SELECT id, strong_key AS "strongKey", weak_key AS "weakKey" FROM catalog_items WHERE import_id = :importId`, { importId });
    },

    async insertGroups(importId, groups) {
      for (const part of chunk(groups, 500)) {
        const values = part.map(() => "(?, ?, ?, ?, ?)").join(",");
        await exec(
          `INSERT INTO catalog_groups (import_id, id, kind, name, sort_order) VALUES ${values}`,
          part.flatMap((g) => [importId, g.id, g.kind, clean(g.name, 300), g.sortOrder]),
        );
      }
    },

    async insertItems(importId, rows) {
      for (const part of chunk(rows, 500)) {
        const values = part.map(() => "(?, ?::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
        await exec(
          `INSERT INTO catalog_items
             (import_id, id, kind, group_id, seq, title, tvg_name, tvg_id, logo, series_id, season, episode, episode_title, ext, origin_enc, strong_key, weak_key)
           VALUES ${values}`,
          part.flatMap((r) => [
            importId, r.id, r.kind, r.groupId, r.seq, clean(r.title, 500) || "Sem título", clean(r.tvgName, 500), clean(r.tvgId, 200), clean(r.logo),
            r.seriesId, r.season, r.episode, clean(r.episodeTitle, 500), r.ext ?? "", r.originEnc, r.strongKey, r.weakKey,
          ]),
        );
      }
    },

    async heartbeat(importId, { now, lockTtlMs }) {
      await exec(`UPDATE catalog_imports SET lock_expires_at = :exp, updated_at = :now WHERE id = :importId AND status = 'running'`, { importId, now, exp: new Date(now.getTime() + lockTtlMs) });
    },

    // Troca ids provisórios por ids da versão anterior (correspondência fraca segura). Sem colisão: os ids reaproveitados
    // são exclusivos (o atribuidor nunca usa o mesmo id duas vezes).
    async reassignIds(importId, pairs) {
      for (const part of chunk(pairs, 1000)) {
        const values = part.map(() => "(?::uuid, ?::uuid)").join(",");
        await exec(
          `UPDATE catalog_items i SET id = v.to_id FROM (VALUES ${values}) AS v(from_id, to_id) WHERE i.import_id = ? AND i.id = v.from_id`,
          [...part.flatMap((p) => [p.from, p.to]), importId],
        );
      }
    },

    async finalizeImport(importId, { groups, series }) {
      await sequelize.transaction(async (transaction) => {
        for (const part of chunk(groups, 1000)) {
          const values = part.map(() => "(?, CAST(? AS int))").join(",");
          await exec(
            `UPDATE catalog_groups g SET item_count = v.c FROM (VALUES ${values}) AS v(id, c) WHERE g.import_id = ? AND g.id = v.id`,
            [...part.flatMap((g) => [g.id, g.itemCount]), importId], transaction,
          );
        }
        for (const part of chunk(series, 500)) {
          const values = part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(",");
          await exec(
            `INSERT INTO catalog_series (import_id, id, group_id, title, logo, seq, season_count, episode_count) VALUES ${values}`,
            part.flatMap((s) => [importId, s.id, s.groupId, clean(s.title, 500) || "Sem título", clean(s.logo), s.seq, s.seasonCount, s.episodeCount]), transaction,
          );
        }
      });
    },

    // Publicação atômica: a versão antiga só deixa de ser ativa na MESMA transação em que a nova passa a ser.
    async publish(importId, scope, { bytes, itemCount, skippedCount, counts, now }) {
      const col = colOf(scope);
      await sequelize.transaction(async (transaction) => {
        await exec(`UPDATE catalog_imports SET is_active = false, status = 'superseded', updated_at = :now WHERE ${col} = :id AND is_active`, { id: scope.id, now }, transaction);
        const done = await select(
          `UPDATE catalog_imports SET status = 'ready', is_active = true, published_at = :now, finished_at = :now, bytes = :bytes, item_count = :itemCount,
                  skipped_count = :skippedCount, counts = CAST(:counts AS jsonb), locked_by = NULL, lock_expires_at = NULL, updated_at = :now
            WHERE id = :importId AND status = 'running' AND ${col} = :id RETURNING id`,
          { importId, id: scope.id, now, bytes, itemCount, skippedCount, counts: JSON.stringify(counts) }, transaction,
        );
        if (done.length !== 1) throw new AppError(409, "IMPORT_NOT_RUNNING", "A importação não está mais em andamento.");
      });
    },

    async failImport(importId, { code, message, stats, now }) {
      await exec(
        `UPDATE catalog_imports SET status = 'failed', is_active = false, error_code = :code, error_message = :message, bytes = :bytes,
                finished_at = :now, locked_by = NULL, lock_expires_at = NULL, updated_at = :now WHERE id = :importId AND status = 'running'`,
        { importId, code, message, bytes: stats?.bytes ?? 0, now },
      );
    },

    // Apaga versões antigas (cascata remove itens/pastas/séries). Nunca toca na ativa nem em importação em andamento.
    async pruneImports(scope, { keepSuperseded, failedBefore }) {
      const col = colOf(scope);
      const rows = await select(
        `DELETE FROM catalog_imports WHERE id IN (
           (SELECT id FROM catalog_imports WHERE ${col} = :id AND status = 'superseded' ORDER BY published_at DESC NULLS LAST OFFSET :keep)
           UNION ALL
           (SELECT id FROM catalog_imports WHERE ${col} = :id AND status = 'failed' AND finished_at < :failedBefore)
         ) RETURNING id`,
        { id: scope.id, keep: keepSuperseded, failedBefore },
      );
      return rows.length;
    },

    /** Descarta TODO o catálogo de um escopo (a lista da ativação mudou). Importação em andamento também é cancelada. */
    async dropScope(scope) {
      const col = colOf(scope);
      const rows = await select(`DELETE FROM catalog_imports WHERE ${col} = :id RETURNING id`, { id: scope.id });
      return rows.length;
    },

    async lastImport(scope) {
      const col = colOf(scope);
      const [r] = await select(
        `SELECT id, status, is_active AS "isActive", published_at AS "publishedAt", finished_at AS "finishedAt", error_code AS "errorCode"
           FROM catalog_imports WHERE ${col} = :id ORDER BY created_at DESC LIMIT 1`, { id: scope.id });
      return r ?? null;
    },

    /* ---------- consultas ---------- */
    async activeImport(scope) {
      const col = colOf(scope);
      const [r] = await select(`SELECT id, status, item_count AS "itemCount", published_at AS "publishedAt" FROM catalog_imports WHERE ${col} = :id AND is_active LIMIT 1`, { id: scope.id });
      return r ?? null;
    },
    async importInScope(id, scope) {
      const col = colOf(scope);
      const [r] = await select(`SELECT id, status FROM catalog_imports WHERE id = :imp AND ${col} = :id`, { imp: id, id: scope.id });
      return r ?? null;
    },
    listGroups: (importId, kind) =>
      select(`SELECT id, name, item_count AS "itemCount" FROM catalog_groups WHERE import_id = :importId AND kind = :kind ORDER BY sort_order, name`, { importId, kind }),

    listItems(importId, { kind, groupId, afterSeq, limit, q }) {
      return select(
        `SELECT id, kind, group_id AS "groupId", seq, title, tvg_id AS "tvgId", logo, series_id AS "seriesId", season, episode, episode_title AS "episodeTitle", ext
           FROM catalog_items
          WHERE import_id = :importId AND kind = :kind ${groupId ? "AND group_id = :groupId" : ""} AND seq > :afterSeq
            ${q ? "AND title ILIKE :like ESCAPE '\\'" : ""}
          ORDER BY seq LIMIT :limit`,
        { importId, kind, groupId, afterSeq, limit, like: q ? likeOf(q) : null },
      );
    },
    listSeries(importId, { groupId, afterSeq, limit, q }) {
      return select(
        `SELECT id, group_id AS "groupId", title, logo, seq, season_count AS "seasonCount", episode_count AS "episodeCount"
           FROM catalog_series
          WHERE import_id = :importId ${groupId ? "AND group_id = :groupId" : ""} AND seq > :afterSeq ${q ? "AND title ILIKE :like ESCAPE '\\'" : ""}
          ORDER BY seq LIMIT :limit`,
        { importId, groupId, afterSeq, limit, like: q ? likeOf(q) : null },
      );
    },
    listSeasons: (importId, seriesId) =>
      select(`SELECT season, count(*)::int AS "episodeCount" FROM catalog_items WHERE import_id = :importId AND series_id = :seriesId GROUP BY season ORDER BY season NULLS FIRST`, { importId, seriesId }),
    listEpisodes(importId, { seriesId, season, after, limit }) {
      return select(
        `SELECT id, kind, group_id AS "groupId", seq, title, tvg_id AS "tvgId", logo, series_id AS "seriesId", season, episode, episode_title AS "episodeTitle", ext
           FROM catalog_items
          WHERE import_id = :importId AND series_id = :seriesId ${season === null ? "" : "AND season = :season"}
            ${after ? "AND (COALESCE(episode, 2147483647), seq) > (:afterE, :afterS)" : ""}
          ORDER BY COALESCE(episode, 2147483647), seq LIMIT :limit`,
        { importId, seriesId, season, afterE: after?.e, afterS: after?.s, limit },
      );
    },
    async getItem(importId, id) {
      const [r] = await select(
        `SELECT id, kind, group_id AS "groupId", seq, title, tvg_id AS "tvgId", logo, series_id AS "seriesId", season, episode, episode_title AS "episodeTitle", ext,
                origin_enc AS "originEnc"
           FROM catalog_items WHERE import_id = :importId AND id = :id`, { importId, id });
      return r ?? null;
    },
  };
}
