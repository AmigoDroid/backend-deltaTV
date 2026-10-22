import { createHash } from "node:crypto";
import { groupKeyOf } from "./m3u-stream.js";

/**
 * Identificadores persistentes de itens entre importações.
 *
 * Regras (segurança primeiro: na dúvida, id NOVO — nunca reaproveitar um id que possa apontar para outro canal):
 *  1. chave forte  = tipo | pasta | tvg-name | tvg-id | URL        (+ ocorrência, para entradas idênticas repetidas)
 *  2. chave fraca  = tipo | pasta | tvg-name | tvg-id              (só vale se for ÚNICA nas duas versões;
 *                    cobre "mesmo canal, URL/token mudou")
 *  3. sem correspondência segura => id novo (o chamador gera o uuid).
 * A posição na playlist nunca entra na chave.
 *
 * Variantes (Globo Brasília HD / FHD) têm tvg-name diferente => chaves diferentes => ids diferentes.
 * tvg-id repetido entre variantes NÃO as unifica (o tvg-name e a URL continuam diferenciando).
 */

const h = (s) => createHash("sha256").update(s).digest("hex");
const norm = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase();

export function strongKeyOf(item) {
  return h(`S\u0000${item.kind}\u0000${groupKeyOf(item.group)}\u0000${norm(item.tvgName)}\u0000${norm(item.tvgId)}\u0000${item.url}`);
}
export function weakKeyOf(item) {
  return h(`W\u0000${item.kind}\u0000${groupKeyOf(item.group)}\u0000${norm(item.tvgName)}\u0000${norm(item.tvgId)}`);
}

/** Fingerprint estável de um item, para guardar na versão publicada (colunas strong_key / weak_key). */
export const fingerprintsOf = (item) => ({ strongKey: strongKeyOf(item), weakKey: weakKeyOf(item) });

/**
 * Atribuidor INCREMENTAL (para importação em streaming, sem guardar a playlist toda):
 *  - assign(item): correspondência forte na hora (fila por chave, na ordem de aparição) -> id reaproveitado ou null;
 *  - os itens sem correspondência forte ficam registrados (só chave fraca + id provisório) para o finalize();
 *  - finalize(): correspondência fraca, apenas onde a chave é ÚNICA nos dois lados e o id ainda está livre.
 * Como a fraca só roda depois de todas as fortes, ela nunca "rouba" um id que um item posterior casaria por chave forte.
 */
export class IncrementalIdAssigner {
  constructor(previous = []) {
    this.strong = new Map();
    this.weakPrevCount = new Map();
    this.weakPrevId = new Map();
    this.used = new Set();
    for (const p of previous) {
      (this.strong.get(p.strongKey) ?? this.strong.set(p.strongKey, []).get(p.strongKey)).push(p.id);
      this.weakPrevCount.set(p.weakKey, (this.weakPrevCount.get(p.weakKey) ?? 0) + 1);
      this.weakPrevId.set(p.weakKey, p.id);
    }
    this.weakNewCount = new Map();
    this.unmatched = []; // { ref, weakKey }
    this.reused = 0;
    this.hasPrevious = previous.length > 0;
  }

  /** @returns {string|null} id reaproveitado (correspondência forte) ou null. `ref` identifica o item para o finalize(). */
  assign(item, ref) {
    const w = weakKeyOf(item);
    this.weakNewCount.set(w, (this.weakNewCount.get(w) ?? 0) + 1);
    if (!this.hasPrevious) return null;
    const queue = this.strong.get(strongKeyOf(item));
    if (queue?.length) {
      const id = queue.shift();
      this.used.add(id);
      this.reused++;
      return id;
    }
    this.unmatched.push({ ref, weakKey: w });
    return null;
  }

  /** @returns {Array<{ref:any,id:string}>} correspondências fracas seguras (o chamador troca o id provisório). */
  finalize() {
    const out = [];
    for (const { ref, weakKey } of this.unmatched) {
      if (this.weakPrevCount.get(weakKey) === 1 && this.weakNewCount.get(weakKey) === 1) {
        const id = this.weakPrevId.get(weakKey);
        if (id && !this.used.has(id)) { this.used.add(id); this.reused++; out.push({ ref, id }); }
      }
    }
    this.unmatched = [];
    return out;
  }
}

/**
 * Versão em lote (usa o atribuidor incremental).
 * @param {Array<{id:string,strongKey:string,weakKey:string}>} previous itens da versão anterior publicada
 * @param {Array<object>} items  itens novos (já normalizados)
 * @returns {{ ids:(string|null)[], reused:number, created:number }}  ids[i] = id reaproveitado ou null (criar)
 */
export function assignStableIds(previous, items) {
  const a = new IncrementalIdAssigner(previous);
  const ids = items.map((it, i) => a.assign(it, i));
  for (const { ref, id } of a.finalize()) ids[ref] = id;
  const reused = ids.filter(Boolean).length;
  return { ids, reused, created: items.length - reused };
}
