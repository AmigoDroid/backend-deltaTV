import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { parseEpisode, classifyContent } from "../sources/m3u.service.js";

/**
 * Parser M3U incremental (streaming).
 *
 * Diferenças deliberadas em relação a M3UService.parse (que continua intacto para os clientes legados):
 *  - nunca materializa o arquivo inteiro: processa linha a linha, com memória O(tamanho da linha);
 *  - cada #EXTINF só é ligado à URL que o segue ANTES do próximo #EXTINF. Um #EXTINF sem URL é descartado
 *    (o parser antigo "emprestava" a URL do item seguinte e desalinhava o resto da lista);
 *  - o título vem da primeira vírgula FORA de aspas (tvg-name="A, B" não quebra o título);
 *  - aceita CRLF, LF e CR isolado; BOM; #EXTINF colado ao fim da linha anterior.
 */

export const KIND_OF = { canais: "live", filmes: "movie", series: "series" };
export const DEFAULT_GROUP = "Sem categoria";

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 256 * 1024 * 1024,
  maxLineLength: 64 * 1024,
  maxItems: 1_000_000,
});

export class M3ULimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "M3ULimitError";
    this.code = code;
  }
}

const nfc = (s) => String(s ?? "").normalize("NFC").trim();

/** Chave normalizada de grupo: usada para identificar a pasta, nunca para exibir. */
export const groupKeyOf = (group) => nfc(group).toLowerCase();

/** Id determinístico de pasta: mesma fonte + mesmo tipo + mesmo nome => mesmo id em qualquer importação. */
export function groupIdFor(sourceId, kind, groupName) {
  return `g_${createHash("sha256").update(`${sourceId}\u0000${kind}\u0000${groupKeyOf(groupName)}`).digest("hex").slice(0, 24)}`;
}

/** Id determinístico de série (por fonte + título normalizado). */
export function seriesIdFor(sourceId, seriesTitle) {
  return `s_${createHash("sha256").update(`${sourceId}\u0000${nfc(seriesTitle).toLowerCase()}`).digest("hex").slice(0, 24)}`;
}

/** Extrai atributos key="value" de uma linha #EXTINF. */
export function parseAttributes(line) {
  const attrs = {};
  const re = /([A-Za-z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2].trim();
  return attrs;
}

/** Posição da vírgula que separa metadados e título: a primeira fora de aspas. */
export function titleSeparator(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 34) inQuotes = !inQuotes;
    else if (c === 44 && !inQuotes) return i;
  }
  return -1;
}

const hasScheme = (u) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(u);

/** Constrói o item normalizado a partir de um #EXTINF e da URL. Retorna null se inválido. */
export function buildItem(extinf, url) {
  if (!url || !hasScheme(url)) return null;
  const attrs = parseAttributes(extinf);
  const sep = titleSeparator(extinf);
  const rawTitle = sep >= 0 ? extinf.slice(sep + 1).trim() : "";
  const title = rawTitle || attrs["tvg-name"] || "Sem título";
  const tvgName = attrs["tvg-name"] || title;
  const group = nfc(attrs["group-title"]) || DEFAULT_GROUP;
  const episodeInfo = parseEpisode(tvgName);
  const legacyType = classifyContent(group, url, tvgName, episodeInfo);
  const kind = KIND_OF[legacyType] ?? "live";
  const item = {
    kind,
    title,
    tvgName,
    tvgId: attrs["tvg-id"] || "",
    logo: attrs["tvg-logo"] || "",
    group,
    url,
  };
  if (kind === "series" && episodeInfo) {
    item.seriesTitle = episodeInfo.seriesTitle;
    item.season = episodeInfo.season;
    item.episode = episodeInfo.episode;
    item.episodeTitle = episodeInfo.episodeTitle;
  }
  return item;
}

/**
 * Gera itens a partir de um iterável assíncrono de Buffer/string (ex.: o corpo de uma resposta HTTP).
 * `stats` é preenchido durante a iteração (bytes, linhas, itens, descartes).
 */
export async function* parseM3UStream(source, { limits = {}, stats = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  Object.assign(stats, { bytes: 0, lines: 0, items: 0, skippedNoUrl: 0, skippedBadUrl: 0, sawHeader: false });

  const decoder = new StringDecoder("utf8");
  let carry = "";
  let pending = null;
  let first = true;

  const handleLine = function* (raw) {
    let line = raw.trim();
    if (first) {
      line = line.replace(/^\uFEFF/, "");
      if (line) first = false;
    }
    if (!line) return;
    stats.lines++;
    // #EXTINF colado ao fim de outra linha (provedores que removem quebras): separa em duas.
    const glued = line.indexOf("#EXTINF", 1);
    if (glued > 0) {
      yield* handleLine(line.slice(0, glued));
      yield* handleLine(line.slice(glued));
      return;
    }
    if (line.startsWith("#EXTM3U")) { stats.sawHeader = true; return; }
    if (line.startsWith("#EXTINF:")) {
      if (pending !== null) stats.skippedNoUrl++;
      pending = line;
      return;
    }
    if (line.startsWith("#")) return; // #EXTVLCOPT, #EXTGRP etc.: ignorados, sem perder o vínculo pendente
    if (pending === null) return; // URL solta
    const item = buildItem(pending, line);
    pending = null;
    if (!item) { stats.skippedBadUrl++; return; }
    if (stats.items >= lim.maxItems) throw new M3ULimitError("M3U_TOO_MANY_ITEMS", "A playlist excede o número máximo de itens.");
    stats.items++;
    yield item;
  };

  const feed = function* (text) {
    carry += text;
    let start = 0;
    for (let i = 0; i < carry.length; i++) {
      const c = carry.charCodeAt(i);
      if (c === 10 || c === 13) {
        if (i > start) yield* handleLine(carry.slice(start, i));
        start = i + 1;
      }
    }
    carry = carry.slice(start);
    if (carry.length > lim.maxLineLength) {
      throw new M3ULimitError("M3U_LINE_TOO_LONG", "A playlist contém uma linha maior que o permitido.");
    }
  };

  for await (const chunk of source) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    stats.bytes += buf.length;
    if (stats.bytes > lim.maxBytes) throw new M3ULimitError("M3U_TOO_LARGE", "A playlist excede o tamanho máximo.");
    yield* feed(decoder.write(buf));
  }
  yield* feed(decoder.end());
  if (carry) yield* handleLine(carry);
  if (pending !== null) stats.skippedNoUrl++;
  if (!stats.sawHeader && stats.items === 0) {
    throw new M3ULimitError("M3U_INVALID", "A origem não retornou uma playlist M3U válida.");
  }
}

/** Agrupa um iterável assíncrono em lotes de tamanho fixo (para gravação em lotes no banco). */
export async function* inBatches(iterable, size) {
  let batch = [];
  for await (const x of iterable) {
    batch.push(x);
    if (batch.length >= size) { yield batch; batch = []; }
  }
  if (batch.length) yield batch;
}
