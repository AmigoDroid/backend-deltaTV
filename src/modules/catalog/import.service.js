import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors.js";
import { parseM3UStream, inBatches, groupIdFor, seriesIdFor, M3ULimitError } from "./m3u-stream.js";
import { IncrementalIdAssigner, fingerprintsOf } from "./stable-ids.js";

/**
 * Importação incremental de catálogo.
 *
 *  1. beginImport: reserva a importação (uma por escopo; coordena instâncias via índice único no banco).
 *  2. stream -> parse -> lotes: grava pastas e itens aos poucos (memória ~ O(lote + nº de pastas/séries)).
 *  3. valida (não vazia; não encolheu de forma suspeita) e SÓ ENTÃO publica, em uma transação, trocando a versão ativa.
 *  4. qualquer falha marca a importação como 'failed' e a versão ativa anterior continua servindo.
 *
 * `repo` é o contrato de persistência (pg.repo.js em produção; memory-repo nos testes).
 * O escopo é {type:'source'|'activation', id}. `scopeKey` entra nos ids de pasta/série: pastas de fontes distintas
 * com o mesmo nome ficam distintas internamente, e o nome visível continua sendo o original do M3U.
 */

export const IMPORT_DEFAULTS = Object.freeze({
  batchSize: 500,
  lockTtlMs: 10 * 60_000,
  minKeepRatio: 0.5, // uma nova versão com menos da metade dos itens da anterior (e a anterior com >= 100) é rejeitada
  minRatioApplyFrom: 100,
});

// Mensagens fixas: nunca gravar e.message cru (pode conter URL de origem com usuário/senha).
const SAFE_MESSAGES = {
  M3U_TOO_LARGE: "A playlist excede o tamanho máximo permitido.",
  M3U_LINE_TOO_LONG: "A playlist contém uma linha maior que o permitido.",
  M3U_TOO_MANY_ITEMS: "A playlist excede o número máximo de itens.",
  M3U_INVALID: "A origem não retornou uma playlist M3U válida.",
  EMPTY_PLAYLIST: "A playlist não contém nenhum item reproduzível.",
  IMPORT_SHRANK: "A nova versão tem muito menos itens que a anterior; a versão anterior foi mantida.",
  ORIGIN_UNAVAILABLE: "Não foi possível baixar a playlist da origem.",
  IMPORT_FAILED: "A importação falhou.",
};
/** Converte QUALQUER erro em {code,message} fixos e seguros para gravar/expor (nunca e.message: pode conter URLs com credenciais). */
export const safeErrorOf = (e) => {
  const c = e?.code ?? e?.importCode;
  let code = "IMPORT_FAILED";
  if (typeof c === "string" && SAFE_MESSAGES[c]) code = c;
  else if ((typeof c === "string" && (c.startsWith("ORIGIN_") || ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ERR_STREAM_PREMATURE_CLOSE", "ABORT_ERR"].includes(c))) || e?.name === "AbortError") code = "ORIGIN_UNAVAILABLE";
  return { code, message: SAFE_MESSAGES[code] };
};

const EXT = /\.(m3u8|ts|mp4|mkv|webm|mp3|aac)$/i;
/** Extensão do fluxo (dica de formato para o player), extraída do caminho da URL. Nunca expõe a URL. */
export const extOf = (url) => { try { return new URL(url).pathname.match(EXT)?.[0].toLowerCase() ?? ""; } catch { return ""; } };

/** Adapta itens já normalizados ({kind,title,group,url,...}) ao mesmo pipeline, preenchendo as estatísticas. */
async function* countItems(items, stats, maxItems = 1_000_000) {
  Object.assign(stats, { bytes: 0, lines: 0, items: 0, skippedNoUrl: 0, skippedBadUrl: 0, sawHeader: true });
  for await (const it of items) {
    if (!it?.url || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(it.url)) { stats.skippedBadUrl++; continue; }
    if (stats.items >= maxItems) throw new M3ULimitError("M3U_TOO_MANY_ITEMS", "A fonte excede o número máximo de itens.");
    stats.items++;
    yield it;
  }
}

export class ImportError extends Error {
  constructor(importCode) { super(SAFE_MESSAGES[importCode]); this.importCode = importCode; this.code = importCode; }
}

/**
 * @param {object} p
 * @param {object} p.repo
 * @param {{type:string,id:string}} p.scope
 * @param {() => AsyncIterable<Buffer|string>} p.openStream  abre o corpo da origem (já com SSRF/redirects tratados)
 * @param {(plain:string)=>string} p.encrypt                cifra a URL de origem de cada item
 */
export async function runImport({ repo, scope, openStream, openItems, encrypt, limits = {}, options = {}, now = () => new Date(), lockedBy = `pid-${process.pid}` }) {
  const opt = { ...IMPORT_DEFAULTS, ...options };
  const scopeKey = `${scope.type}:${scope.id}`;
  const t0 = now().getTime();

  const { importId, previous } = await repo.beginImport({ scope, lockedBy, lockTtlMs: opt.lockTtlMs, now: now() });
  const stats = {};
  try {
    const prevFingerprints = previous ? await repo.loadFingerprints(previous.id) : [];
    const assigner = new IncrementalIdAssigner(prevFingerprints);
    const groups = new Map();
    const series = new Map();
    const counts = { live: 0, movie: 0, series: 0 };
    let seq = 0;

    const source = openItems ? countItems(openItems(), stats, limits.maxItems) : parseM3UStream(openStream(), { limits, stats });
    for await (const batch of inBatches(source, opt.batchSize)) {
      const rows = [];
      const newGroups = [];
      for (const item of batch) {
        const gid = groupIdFor(scopeKey, item.kind, item.group);
        let g = groups.get(gid);
        if (!g) {
          g = { id: gid, kind: item.kind, name: item.group, sortOrder: groups.size, count: 0 };
          groups.set(gid, g);
          newGroups.push(g);
        }
        g.count++;
        counts[item.kind]++;
        seq++;

        const ref = { id: randomUUID() };
        const reused = assigner.assign(item, ref);
        const row = {
          id: reused ?? ref.id, kind: item.kind, groupId: gid, seq,
          title: item.title, tvgName: item.tvgName, tvgId: item.tvgId, logo: item.logo,
          seriesId: null, season: null, episode: null, episodeTitle: null,
          ext: extOf(item.url), originEnc: encrypt(item.url), ...fingerprintsOf(item),
        };
        if (item.kind === "series") {
          // Sem SxxExx no título, o item vira uma "série" de um item só (sem temporada/episódio), sem sumir do catálogo.
          const title = item.seriesTitle ?? item.title;
          const sid = seriesIdFor(scopeKey, title);
          let s = series.get(sid);
          if (!s) { s = { id: sid, groupId: gid, title, logo: item.logo, seq, seasons: new Set(), episodeCount: 0 }; series.set(sid, s); }
          if (!s.logo && item.logo) s.logo = item.logo;
          if (item.season != null) s.seasons.add(item.season);
          s.episodeCount++;
          Object.assign(row, { seriesId: sid, season: item.season ?? null, episode: item.episode ?? null, episodeTitle: item.episodeTitle ?? null });
        }
        rows.push(row);
      }
      if (newGroups.length) await repo.insertGroups(importId, newGroups);
      await repo.insertItems(importId, rows);
      await repo.heartbeat(importId, { now: now(), lockTtlMs: opt.lockTtlMs });
    }

    if (stats.items === 0) throw new ImportError("EMPTY_PLAYLIST");
    if (previous && previous.itemCount >= opt.minRatioApplyFrom && stats.items < previous.itemCount * opt.minKeepRatio) {
      throw new ImportError("IMPORT_SHRANK");
    }

    const weak = assigner.finalize();
    if (weak.length) await repo.reassignIds(importId, weak.map(({ ref, id }) => ({ from: ref.id, to: id })));

    await repo.finalizeImport(importId, {
      groups: [...groups.values()].map((g) => ({ id: g.id, itemCount: g.count })),
      series: [...series.values()].map((s) => ({ id: s.id, groupId: s.groupId, title: s.title, logo: s.logo, seq: s.seq, seasonCount: s.seasons.size, episodeCount: s.episodeCount })),
    });
    await repo.publish(importId, scope, {
      bytes: stats.bytes, itemCount: stats.items, skippedCount: stats.skippedNoUrl + stats.skippedBadUrl, counts, now: now(),
    });
    return {
      importId, itemCount: stats.items, skipped: stats.skippedNoUrl + stats.skippedBadUrl, counts,
      groups: groups.size, reusedIds: assigner.reused, newIds: stats.items - assigner.reused,
      bytes: stats.bytes, durationMs: now().getTime() - t0,
    };
  } catch (e) {
    const safe = safeErrorOf(e);
    // Falha ao gravar a falha não pode esconder o erro original.
    await repo.failImport(importId, { ...safe, stats, now: now() }).catch(() => {});
    throw e;
  }
}

/**
 * Limpeza controlada: mantém a versão ativa + `keepSuperseded` anteriores (para navegações em andamento e rollback)
 * e apaga importações com falha antigas. Nunca toca na ativa nem em importação em andamento.
 */
export async function pruneImports({ repo, scope, keepSuperseded = 1, failedOlderThanMs = 7 * 86_400_000, now = () => new Date() }) {
  return repo.pruneImports(scope, { keepSuperseded, failedBefore: new Date(now().getTime() - failedOlderThanMs) });
}
