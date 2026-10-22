import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/errors.js";
import { EPISODE_NULL } from "../../src/modules/catalog/query.service.js";

/**
 * Repositório em memória que imita as garantias do esquema PostgreSQL (migration 20261018000003):
 *  - uma importação ativa e uma em andamento por escopo (índices parciais únicos);
 *  - (import_id, id) e (import_id, kind, group_id, seq) únicos; item exige a pasta (FK);
 *  - publicação atômica (tudo ou nada).
 * Serve para testar a LÓGICA de importação/consulta. Não valida SQL: isso exige PostgreSQL (npm run verify:db).
 */
export class MemoryCatalogRepo {
  constructor({ failInsertAtBatch = null, failPublish = false } = {}) {
    this.imports = new Map();
    this.groups = new Map(); // importId -> Map(groupId -> group)
    this.items = new Map(); // importId -> array
    this.series = new Map(); // importId -> array
    this.failInsertAtBatch = failInsertAtBatch;
    this.failPublish = failPublish;
    this.batches = 0;
    this.maxItemsHeldInBatch = 0;
  }
  key(scope) { return `${scope.type}:${scope.id}`; }
  forScope(scope) { return [...this.imports.values()].filter((i) => i.scopeKey === this.key(scope)); }

  async beginImport({ scope, lockedBy, lockTtlMs, now }) {
    const mine = this.forScope(scope);
    for (const i of mine.filter((x) => ["queued", "running"].includes(x.status))) {
      if (i.lockExpiresAt > now) throw new AppError(409, "IMPORT_IN_PROGRESS", "Já existe uma importação em andamento.");
      Object.assign(i, { status: "failed", errorCode: "STALE_LOCK", finishedAt: now });
    }
    const active = mine.find((x) => x.isActive) ?? null;
    const row = { id: randomUUID(), scopeKey: this.key(scope), scope, status: "running", isActive: false, bytes: 0, itemCount: 0, skippedCount: 0, counts: {}, lockedBy, lockExpiresAt: new Date(now.getTime() + lockTtlMs), startedAt: now, createdAt: now };
    this.imports.set(row.id, row);
    this.groups.set(row.id, new Map());
    this.items.set(row.id, []);
    this.series.set(row.id, []);
    return { importId: row.id, previous: active ? { id: active.id, itemCount: active.itemCount } : null };
  }
  async loadFingerprints(importId) {
    return this.items.get(importId).map((r) => ({ id: r.id, strongKey: r.strongKey, weakKey: r.weakKey }));
  }
  async insertGroups(importId, groups) {
    const m = this.groups.get(importId);
    for (const g of groups) {
      if (m.has(g.id)) throw new Error("grupo duplicado");
      m.set(g.id, { ...g, itemCount: 0 });
    }
  }
  async insertItems(importId, rows) {
    this.batches++;
    this.maxItemsHeldInBatch = Math.max(this.maxItemsHeldInBatch, rows.length);
    if (this.failInsertAtBatch && this.batches === this.failInsertAtBatch) throw new Error("falha simulada de gravação (postgres://user:SENHA@host)");
    const items = this.items.get(importId);
    const groups = this.groups.get(importId);
    const ids = this._idset ??= new Map();
    const seen = ids.get(importId) ?? ids.set(importId, new Set()).get(importId);
    for (const r of rows) {
      if (!groups.has(r.groupId)) throw new Error("FK: pasta inexistente");
      if (seen.has(r.id)) throw new Error("PK duplicada (import_id,id)");
      seen.add(r.id);
      items.push({ ...r });
    }
  }
  async heartbeat(importId, { now, lockTtlMs }) { this.imports.get(importId).lockExpiresAt = new Date(now.getTime() + lockTtlMs); }
  async reassignIds(importId, pairs) {
    const items = this.items.get(importId);
    const byId = new Map(items.map((r) => [r.id, r]));
    const seen = this._idset.get(importId);
    for (const { from, to } of pairs) {
      if (seen.has(to)) throw new Error("PK duplicada ao reaproveitar id");
      byId.get(from).id = to; seen.delete(from); seen.add(to);
    }
  }
  async finalizeImport(importId, { groups, series }) {
    const m = this.groups.get(importId);
    for (const g of groups) m.get(g.id).itemCount = g.itemCount;
    this.series.set(importId, series.map((s) => ({ ...s })));
  }
  async publish(importId, scope, stats) {
    if (this.failPublish) throw new Error("falha simulada na publicação");
    const snapshot = [...this.forScope(scope)].map((i) => ({ i, copy: { ...i } }));
    try {
      for (const i of this.forScope(scope)) if (i.isActive) Object.assign(i, { isActive: false, status: "superseded" });
      Object.assign(this.imports.get(importId), { status: "ready", isActive: true, publishedAt: stats.now, finishedAt: stats.now, bytes: stats.bytes, itemCount: stats.itemCount, skippedCount: stats.skippedCount, counts: stats.counts });
    } catch (e) { for (const { i, copy } of snapshot) Object.assign(i, copy); throw e; }
  }
  async failImport(importId, { code, message, stats, now }) {
    Object.assign(this.imports.get(importId), { status: "failed", isActive: false, errorCode: code, errorMessage: message, finishedAt: now, bytes: stats?.bytes ?? 0 });
  }
  async pruneImports(scope, { keepSuperseded, failedBefore }) {
    const mine = this.forScope(scope);
    const superseded = mine.filter((i) => i.status === "superseded").sort((a, b) => b.publishedAt - a.publishedAt);
    const drop = [...superseded.slice(keepSuperseded), ...mine.filter((i) => i.status === "failed" && i.finishedAt < failedBefore)];
    for (const i of drop) { this.imports.delete(i.id); this.groups.delete(i.id); this.items.delete(i.id); this.series.delete(i.id); }
    return drop.length;
  }

  /* ---- consultas ---- */
  async activeImport(scope) { const i = this.forScope(scope).find((x) => x.isActive); return i ? { id: i.id, status: i.status, itemCount: i.itemCount } : null; }
  async importInScope(id, scope) { const i = this.imports.get(id); return i && i.scopeKey === this.key(scope) ? { id: i.id, status: i.status } : null; }
  async listGroups(importId, kind) {
    return [...this.groups.get(importId).values()].filter((g) => g.kind === kind).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }
  async listItems(importId, { kind, groupId, afterSeq, limit, q }) {
    const needle = q?.toLowerCase();
    return this.items.get(importId)
      .filter((r) => r.kind === kind && (!groupId || r.groupId === groupId) && r.seq > afterSeq && (!needle || r.title.toLowerCase().includes(needle)))
      .sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  async listSeries(importId, { groupId, afterSeq, limit, q }) {
    const needle = q?.toLowerCase();
    return this.series.get(importId).filter((s) => (!groupId || s.groupId === groupId) && s.seq > afterSeq && (!needle || s.title.toLowerCase().includes(needle)))
      .sort((a, b) => a.seq - b.seq).slice(0, limit);
  }
  async listSeasons(importId, seriesId) {
    const by = new Map();
    for (const r of this.items.get(importId)) if (r.seriesId === seriesId) by.set(r.season, (by.get(r.season) ?? 0) + 1);
    return [...by].map(([season, episodeCount]) => ({ season, episodeCount })).sort((a, b) => (a.season ?? -1) - (b.season ?? -1));
  }
  async listEpisodes(importId, { seriesId, season, after, limit }) {
    const ek = (r) => r.episode ?? EPISODE_NULL;
    return this.items.get(importId)
      .filter((r) => r.seriesId === seriesId && (season === null || r.season === season))
      .filter((r) => !after || ek(r) > after.e || (ek(r) === after.e && r.seq > after.s))
      .sort((a, b) => ek(a) - ek(b) || a.seq - b.seq).slice(0, limit);
  }
  async getItem(importId, id) { return this.items.get(importId).find((r) => r.id === id) ?? null; }
}
