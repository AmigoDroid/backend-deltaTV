import { Op } from "sequelize";
import { sequelize, Channel, Category } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { encryptSecret, decryptSecret } from "../../shared/crypto.js";
import { createPgCatalogRepo } from "./pg.repo.js";
import { runImport, pruneImports, safeErrorOf } from "./import.service.js";
import {
  setCatalogInvalidator,
  playlistUrlForActivation,
  playlistUrlForSource,
  openPlaylistStream,
} from "../sources/sources.service.js";

/**
 * Integração do catálogo persistente com o resto do backend (NÃO VALIDADO sem PostgreSQL).
 *  - dispara importações em SEGUNDO PLANO (a requisição do cliente nunca espera o download);
 *  - evita importação duplicada no processo (Map) e entre instâncias (índice único parcial no banco);
 *  - limita importações simultâneas (CATALOG_IMPORT_CONCURRENCY) e o tempo total (CATALOG_IMPORT_TIMEOUT_MS);
 *  - atualização "stale-while-revalidate": passou CATALOG_REFRESH_HOURS, a versão atual segue servindo enquanto a nova é importada;
 *  - falha recente não é repetida a cada requisição (backoff), e a última versão válida continua servindo.
 */
export const repo = createPgCatalogRepo(sequelize);

const FAIL_BACKOFF_MS = 5 * 60_000;
const running = new Map();
const aborters = new Map();
let slots = Math.max(1, env.catalogConcurrency);
const waiters = [];
const acquire = () =>
  slots > 0
    ? (slots--, Promise.resolve())
    : new Promise((r) => waiters.push(r));
const release = () => {
  const w = waiters.shift();
  if (w) w();
  else slots++;
};

export const scopeKeyOf = (scope) => `${scope.type}:${scope.id}`;
const log = (level, msg, data) =>
  console[level](JSON.stringify({ msg, ...data }));

async function* channelItems(source) {
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const rows = await Channel.findAll({
      where: { sourceId: source.id, status: "active" },
      include: [Category],
      order: [
        ["sortOrder", "ASC"],
        ["name", "ASC"],
        ["id", "ASC"],
      ],
      limit,
      offset,
    });
    if (!rows.length) return;
    for (const c of rows) {
      yield {
        kind: c.kind,
        title: c.name,
        tvgName: c.name,
        tvgId: "",
        logo: c.logoUrl ?? "",
        group: c.Category?.name ?? "Sem categoria",
        url: decryptSecret(c.streamUrlEnc),
      };
    }
  }
}

/** ctx: { scope, activation } (lista da TV) ou { scope, source } (fonte global/de parceria). */
async function openersFor(ctx, signal) {
  if (ctx.source?.kind === "catalog")
    return { openItems: () => channelItems(ctx.source) };
  const url = ctx.activation
    ? await playlistUrlForActivation(ctx.activation)
    : playlistUrlForSource(ctx.source);
  return {
    openStream: async function* () {
      const res = await openPlaylistStream(url, {
        maxBytes: env.catalogMaxBytes,
        signal,
      });
      try {
        yield* res;
      } finally {
        res.destroy();
      }
    },
  };
}

export function startImport(ctx) {
  const key = scopeKeyOf(ctx.scope);
  if (running.has(key)) return running.get(key);
  const p = (async () => {
    await acquire();
    const ac = new AbortController();
    aborters.set(key, ac);
    const timer = setTimeout(() => ac.abort(), env.catalogImportTimeoutMs);
    try {
      const openers = await openersFor(ctx, ac.signal);
      const r = await runImport({
        repo,
        scope: ctx.scope,
        ...openers,
        encrypt: encryptSecret,
        limits: { maxBytes: env.catalogMaxBytes },
      });
      log("info", "catalog.import.ok", {
        scope: key,
        items: r.itemCount,
        groups: r.groups,
        reused: r.reusedIds,
        bytes: r.bytes,
        ms: r.durationMs,
      });
      await pruneImports({ repo, scope: ctx.scope }).catch(() => {});
      return r;
    } catch (e) {
      if (e?.code !== "IMPORT_IN_PROGRESS")
        log("warn", "catalog.import.failed", {
          scope: key,
          code: safeErrorOf(e).code,
          rawCode: e?.code ?? e?.name ?? null,
          status: e?.status ?? e?.statusCode ?? null,
        }); // rawCode/status: diagnóstico sem URL nem credenciais
      return null;
    } finally {
      clearTimeout(timer);
      release();
      if (aborters.get(key) === ac) aborters.delete(key);
      if (running.get(key) === p) running.delete(key); // não apaga a entrada de uma importação mais nova
    }
  })();
  running.set(key, p);
  return p;
}

/** Garante que exista (ou esteja sendo preparado) um catálogo para o escopo. Nunca bloqueia no download. */
export async function ensureCatalog(ctx) {
  if (running.has(scopeKeyOf(ctx.scope))) return "importing";
  const active = await repo.activeImport(ctx.scope);
  if (active) {
    const age = Date.now() - new Date(active.publishedAt).getTime();
    if (age < env.catalogRefreshHours * 3_600_000) return "ready";
    startImport(ctx);
    return "refreshing";
  }
  const last = await repo.lastImport(ctx.scope);
  if (
    last?.status === "failed" &&
    Date.now() - new Date(last.finishedAt).getTime() < FAIL_BACKOFF_MS
  )
    return "failed";
  startImport(ctx);
  return "importing";
}

// A lista de uma TV mudou: o catálogo antigo dessa ativação não pode mais ser servido.
setCatalogInvalidator(async (activationId) => {
  const scope = { type: "activation", id: activationId };
  const key = scopeKeyOf(scope);
  aborters.get(key)?.abort(); // interrompe o download da lista antiga
  await repo.dropScope(scope);
  running.delete(key); // libera para uma nova importação com a lista nova
});
