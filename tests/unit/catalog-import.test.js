import test from "node:test";
import assert from "node:assert/strict";
import { runImport, pruneImports, safeErrorOf } from "../../src/modules/catalog/import.service.js";
import * as Q from "../../src/modules/catalog/query.service.js";
import { MemoryCatalogRepo } from "../helpers/memory-catalog-repo.js";

/* ---------- helpers ---------- */
const attr = (e) => `#EXTINF:-1 tvg-id="${e.tvgId ?? ""}" tvg-name="${e.name}" tvg-logo="${e.logo ?? ""}" group-title="${e.group ?? ""}",${e.name}\r\n${e.url}`;
const m3u = (entries) => `#EXTM3U\r\n${entries.map(attr).join("\r\n")}\r\n`;
let n = 0;
const live = (name, group, o = {}) => ({ name, group: group === undefined ? undefined : `CANAIS | ${group}`, url: `http://prov.example/live/u/p/${o.n ?? ++n}.ts`, tvgId: o.tvgId });
const movie = (name, group) => ({ name, group: `FILMES | ${group}`, url: `http://prov.example/movie/u/p/${++n}.mp4`, logo: "http://img/x.jpg" });
const ep = (serie, s, e, group = "NOVELAS") => ({ name: `${serie} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`, group: `SÉRIES | ${group}`, url: `http://prov.example/series/u/p/${++n}.mp4` });
const chunks = (text, size = 4096) => async function* () { const b = Buffer.from(text); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); };
const encrypt = (s) => `enc(${s})`;
const A = { type: "activation", id: "act-A" };
const B = { type: "activation", id: "act-B" };
const imp = (repo, scope, entries, extra = {}) => runImport({ repo, scope, openStream: chunks(m3u(entries)), encrypt, ...extra });
const allItems = async (repo, scope, kind, groupId, pageSize = 2) => {
  const out = []; let cursor;
  do { const r = await Q.listItems({ repo, scope, kind, groupId, cursor, pageSize }); out.push(...r.items); cursor = r.nextCursor; } while (cursor);
  return out;
};
const base = () => [
  live("Globo Maranhão", "Globo", { tvgId: "globo" }), live("Globo Brasília FHD", "Globo", { tvgId: "globo" }), live("Globo Brasília HD", "Globo", { tvgId: "globo" }),
  live("ESPN", "Esportes"), live("SporTV", "Esportes"), live("Canal Solto", undefined),
  movie("Duro de Matar", "AÇÃO"), movie("Rambo", "AÇÃO"), movie("Titanic", "DRAMA"),
  ep("Novela X", 1, 1), ep("Novela X", 1, 2), ep("Novela X", 2, 1), ep("Outra", 1, 1, "DRAMAS"),
];

/* ---------- estrutura e hierarquia ---------- */
test("TV ao vivo: pastas com o nome ORIGINAL do group-title (inclusive prefixos), na ordem do M3U, com contagem; 'Sem categoria' não é descartada", async () => {
  const repo = new MemoryCatalogRepo();
  const r = await imp(repo, A, base());
  assert.equal(r.itemCount, 13);
  const g = await Q.listGroups({ repo, scope: A, kind: "live" });
  assert.deepEqual(g.groups.map((x) => [x.name, x.itemCount]), [["CANAIS | Globo", 3], ["CANAIS | Esportes", 2], ["Sem categoria", 1]]);
  assert.deepEqual((await Q.listGroups({ repo, scope: A, kind: "movie" })).groups.map((x) => x.name), ["FILMES | AÇÃO", "FILMES | DRAMA"]);
});

test("canais de uma pasta: só os dela, paginados, sem perda nem duplicação, variantes independentes", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const globo = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const items = await allItems(repo, A, "live", globo.id, 2);
  assert.deepEqual(items.map((i) => i.title), ["Globo Maranhão", "Globo Brasília FHD", "Globo Brasília HD"]);
  assert.equal(new Set(items.map((i) => i.id)).size, 3, "ids distintos mesmo com tvg-id repetido");
  assert.ok(items.every((i) => i.tvgId === "globo"), "tvg-id preservado, sem deduplicar");
  const first = await Q.listItems({ repo, scope: A, kind: "live", groupId: globo.id, pageSize: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
});

test("respostas públicas nunca trazem URL de origem nem credenciais", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const page = await Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, pageSize: 40 });
  const json = JSON.stringify(page) + JSON.stringify(await Q.getItem({ repo, scope: A, id: page.items[0].id }));
  assert.equal(/prov\.example|enc\(|\/u\/p\/|originEnc|strongKey/.test(json), false);
});

test("live exige a pasta; movie aceita pasta ou pesquisa; kind inválido é recusado", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live" }), (e) => e.status === 400);
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "movie" }), (e) => e.status === 400);
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "tv", groupId: "x" }), (e) => e.status === 400);
  const found = await Q.listItems({ repo, scope: A, kind: "movie", q: "rambo" });
  assert.deepEqual(found.items.map((i) => i.title), ["Rambo"]);
});

test("filmes paginados por categoria", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const acao = (await Q.listGroups({ repo, scope: A, kind: "movie" })).groups[0];
  const all = await allItems(repo, A, "movie", acao.id, 1);
  assert.deepEqual(all.map((i) => i.title), ["Duro de Matar", "Rambo"]);
});

test("séries -> temporadas -> episódios, ordenados por número mesmo com playlist embaralhada", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, [ep("Novela X", 1, 3), ep("Novela X", 1, 1), ep("Novela X", 2, 1), ep("Novela X", 1, 2), { name: "Documentário Solto", group: "SÉRIES | DOCS", url: "http://prov.example/series/u/p/9999.mp4" }]);
  const list = await Q.listSeries({ repo, scope: A, pageSize: 10 });
  assert.deepEqual(list.series.map((s) => [s.title, s.seasonCount, s.episodeCount]), [["Novela X", 2, 4], ["Documentário Solto", 0, 1]]);
  const sid = list.series[0].id;
  assert.deepEqual((await Q.listSeasons({ repo, scope: A, seriesId: sid })).seasons, [{ season: 1, episodeCount: 3 }, { season: 2, episodeCount: 1 }]);
  const eps = []; let cursor;
  do { const r = await Q.listEpisodes({ repo, scope: A, seriesId: sid, season: 1, cursor, pageSize: 2 }); eps.push(...r.episodes); cursor = r.nextCursor; } while (cursor);
  assert.deepEqual(eps.map((e) => e.episode), [1, 2, 3]);
  await assert.rejects(Q.listSeasons({ repo, scope: A, seriesId: "s_inexistente" }), (e) => e.status === 404);
});

/* ---------- ids estáveis e reprodução ---------- */
test("reimportar com a ordem trocada mantém todos os ids e a referência de reprodução", async () => {
  const repo = new MemoryCatalogRepo();
  const entries = base();
  await imp(repo, A, entries);
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const before = await allItems(repo, A, "live", g.id);
  const urlBefore = await Promise.all(before.map(async (i) => (await Q.resolvePlayable({ repo, scope: A, id: i.id })).originEnc));
  const r2 = await imp(repo, A, [...entries].reverse());
  assert.equal(r2.newIds, 0);
  assert.equal(r2.reusedIds, 13);
  const g2 = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups.find((x) => x.name === "CANAIS | Globo");
  const after = await allItems(repo, A, "live", g2.id);
  assert.deepEqual(new Set(after.map((i) => i.id)), new Set(before.map((i) => i.id)));
  const urlAfter = await Promise.all(before.map(async (i) => (await Q.resolvePlayable({ repo, scope: A, id: i.id })).originEnc));
  assert.deepEqual(urlAfter, urlBefore, "o mesmo id continua apontando para o mesmo fluxo");
});

test("URL/credencial rotacionada: canal inequívoco mantém o id; nome ambíguo ganha id novo", async () => {
  const repo = new MemoryCatalogRepo();
  const v1 = [live("Canal Único", "G", { n: 1 }), live("Repetido", "G", { n: 2 }), live("Repetido", "G", { n: 3 })];
  await imp(repo, A, v1);
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const ids1 = (await allItems(repo, A, "live", g.id)).map((i) => i.id);
  const v2 = [live("Canal Único", "G", { n: 11 }), live("Repetido", "G", { n: 12 }), live("Repetido", "G", { n: 13 })];
  const r = await imp(repo, A, v2);
  const ids2 = (await allItems(repo, A, "live", g.id)).map((i) => i.id);
  assert.equal(ids2[0], ids1[0], "inequívoco: mesmo id");
  assert.notEqual(ids2[1], ids1[1]); assert.notEqual(ids2[2], ids1[2]);
  assert.equal(r.reusedIds, 1);
});

test("item removido da nova versão deixa de reproduzir; os demais continuam", async () => {
  const repo = new MemoryCatalogRepo();
  const e = [live("A", "G", { n: 1 }), live("B", "G", { n: 2 })];
  await imp(repo, A, e);
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const [a, b] = await allItems(repo, A, "live", g.id);
  await imp(repo, A, [e[0]]);
  assert.ok(await Q.resolvePlayable({ repo, scope: A, id: a.id }));
  assert.equal(await Q.resolvePlayable({ repo, scope: A, id: b.id }), null);
});

/* ---------- falhas preservam a versão anterior ---------- */
test("falha no meio da gravação: versão anterior segue ativa e o erro não vaza credenciais", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const activeBefore = (await repo.activeImport(A)).id;
  repo.failInsertAtBatch = 3; // 1ª import usou 1 lote; o lote 3 é o 2º da nova (batchSize 5)
  await assert.rejects(imp(repo, A, [...base(), ...base()], { options: { batchSize: 5 } }), /falha simulada/);
  assert.equal((await repo.activeImport(A)).id, activeBefore);
  assert.equal((await Q.listGroups({ repo, scope: A, kind: "live" })).groups.length, 3, "continua servindo a versão antiga");
  const failed = [...repo.imports.values()].find((i) => i.status === "failed");
  assert.equal(failed.errorCode, "IMPORT_FAILED");
  assert.equal(/SENHA|postgres:/.test(JSON.stringify(failed)), false, "mensagem gravada é fixa, sem dados da falha");
});

test("playlist vazia, HTML de erro e linha gigante falham sem trocar a versão ativa", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const active = (await repo.activeImport(A)).id;
  await assert.rejects(runImport({ repo, scope: A, openStream: chunks("#EXTM3U\n"), encrypt }), (e) => e.code === "EMPTY_PLAYLIST");
  await assert.rejects(runImport({ repo, scope: A, openStream: chunks("<html>403</html>"), encrypt }), (e) => e.code === "M3U_INVALID");
  await assert.rejects(runImport({ repo, scope: A, openStream: chunks("#EXTM3U\n" + "x".repeat(2000)), encrypt, limits: { maxLineLength: 500 } }), (e) => e.code === "M3U_LINE_TOO_LONG");
  assert.equal((await repo.activeImport(A)).id, active);
});

test("nova versão que encolhe de forma suspeita (>=100 -> <50%) é rejeitada", async () => {
  const repo = new MemoryCatalogRepo();
  const big = Array.from({ length: 200 }, (_, i) => live(`C${i}`, "G", { n: i + 1 }));
  await imp(repo, A, big);
  await assert.rejects(imp(repo, A, big.slice(0, 50)), (e) => e.code === "IMPORT_SHRANK");
  assert.equal((await repo.activeImport(A)).itemCount, 200);
  await imp(repo, A, big.slice(0, 120)); // 60%: aceita
  assert.equal((await repo.activeImport(A)).itemCount, 120);
});

test("falha na publicação mantém a versão anterior e marca a nova como 'failed'", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const active = (await repo.activeImport(A)).id;
  repo.failPublish = true;
  await assert.rejects(imp(repo, A, base()), /publicação/);
  repo.failPublish = false;
  assert.equal((await repo.activeImport(A)).id, active);
  assert.equal([...repo.imports.values()].filter((i) => i.status === "failed").length, 1);
  assert.equal([...repo.imports.values()].filter((i) => i.isActive).length, 1);
});

/* ---------- coordenação ---------- */
test("duas importações simultâneas do mesmo escopo: a segunda é recusada; escopos diferentes não se bloqueiam", async () => {
  const repo = new MemoryCatalogRepo();
  let release; const gate = new Promise((r) => { release = r; });
  const slow = async function* () { await gate; yield* chunks(m3u(base()))(); };
  const first = runImport({ repo, scope: A, openStream: slow, encrypt });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(imp(repo, A, base()), (e) => e.code === "IMPORT_IN_PROGRESS" && e.status === 409);
  await imp(repo, B, base()); // outro escopo segue livre
  release();
  assert.equal((await first).itemCount, 13);
});

test("trava vencida (instância que caiu) é recuperada na próxima importação", async () => {
  const repo = new MemoryCatalogRepo();
  const t0 = new Date("2026-10-17T12:00:00Z");
  await repo.beginImport({ scope: A, lockedBy: "morto", lockTtlMs: 1000, now: t0 }); // nunca termina
  const later = () => new Date(t0.getTime() + 60_000);
  const r = await imp(repo, A, base(), { now: later });
  assert.equal(r.itemCount, 13);
  assert.ok([...repo.imports.values()].some((i) => i.errorCode === "STALE_LOCK"));
});

/* ---------- consistência durante a navegação ---------- */
test("republicação no meio da navegação: cursor continua na versão antiga; depois de limpa, 409 controlado", async () => {
  const repo = new MemoryCatalogRepo();
  const many = Array.from({ length: 6 }, (_, i) => live(`C${i}`, "G", { n: i + 1 }));
  await imp(repo, A, many);
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const p1 = await Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, pageSize: 2 });
  assert.equal(p1.outdated, false);
  await imp(repo, A, [live("NOVO", "G", { n: 99 }), ...many]);
  const p2 = await Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, cursor: p1.nextCursor, pageSize: 2 });
  assert.deepEqual(p2.items.map((i) => i.title), ["C2", "C3"], "mesma ordem e mesma versão da 1ª página");
  assert.equal(p2.outdated, true);
  assert.notEqual(p2.latestVersion, p2.catalogVersion);
  await pruneImports({ repo, scope: A, keepSuperseded: 0 });
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, cursor: p2.nextCursor, pageSize: 2 }), (e) => e.status === 409 && e.code === "CATALOG_VERSION_GONE");
  const fresh = await Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, pageSize: 2 });
  assert.equal(fresh.items[0].title, "NOVO");
});

test("cursor adulterado ou de outro escopo não dá acesso a nada", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, [live("A1", "G", { n: 1 }), live("A2", "G", { n: 2 }), live("A3", "G", { n: 3 })]);
  await imp(repo, B, [live("B1", "G", { n: 4 }), live("B2", "G", { n: 5 }), live("B3", "G", { n: 6 })]);
  const gA = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const gB = (await Q.listGroups({ repo, scope: B, kind: "live" })).groups[0];
  assert.notEqual(gA.id, gB.id, "mesma pasta em escopos diferentes tem ids diferentes");
  const pB = await Q.listItems({ repo, scope: B, kind: "live", groupId: gB.id, pageSize: 1 });
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live", groupId: gA.id, cursor: pB.nextCursor }), (e) => e.code === "CATALOG_VERSION_GONE");
  const viaGroup = await Q.listItems({ repo, scope: A, kind: "live", groupId: gB.id, pageSize: 40 });
  assert.deepEqual(viaGroup.items, [], "usar a pasta de outro escopo não revela nada");
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live", groupId: gA.id, cursor: "%%%" }), (e) => e.code === "INVALID_CURSOR");
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live", groupId: gA.id, cursor: Buffer.from('{"v":"1","s":1}').toString("base64url") }), (e) => e.code === "INVALID_CURSOR");
  assert.equal(await Q.resolvePlayable({ repo, scope: A, id: (await Q.listItems({ repo, scope: B, kind: "live", groupId: gB.id })).items[0].id }), null, "id de outro escopo não reproduz");
});

test("sem catálogo publicado: 503 'preparando' (nunca um catálogo de demonstração)", async () => {
  const repo = new MemoryCatalogRepo();
  await assert.rejects(Q.listGroups({ repo, scope: A, kind: "live" }), (e) => e.status === 503 && e.code === "CATALOG_PREPARING");
});

test("tamanho de página é limitado", () => {
  assert.equal(Q.clampPageSize(1000), 100);
  assert.equal(Q.clampPageSize(0), 1);
  assert.equal(Q.clampPageSize(undefined), 40);
  assert.equal(Q.clampPageSize("abc"), 40);
});

/* ---------- limpeza ---------- */
test("limpeza mantém a ativa e N anteriores, e nunca apaga importação em andamento", async () => {
  const repo = new MemoryCatalogRepo();
  for (let i = 0; i < 4; i++) await imp(repo, A, [live(`C${i}`, "G", { n: i + 1 })]);
  const running = await repo.beginImport({ scope: B, lockedBy: "x", lockTtlMs: 600000, now: new Date() });
  const deleted = await pruneImports({ repo, scope: A, keepSuperseded: 1 });
  assert.equal(deleted, 2);
  assert.equal(repo.forScope(A).length, 2);
  assert.ok(repo.forScope(A).some((i) => i.isActive));
  assert.equal(await pruneImports({ repo, scope: B }), 0);
  assert.ok(repo.imports.has(running.importId));
});

/* ---------- volume ---------- */
test("20 mil itens: importa em lotes, pastas e paginação corretas", async () => {
  const repo = new MemoryCatalogRepo();
  const entries = Array.from({ length: 20_000 }, (_, i) => live(`Canal ${i}`, `G${i % 50}`, { n: i + 1 }));
  const r = await imp(repo, A, entries);
  assert.equal(r.itemCount, 20_000);
  assert.ok(repo.maxItemsHeldInBatch <= 500, "gravação em lotes de no máximo batchSize");
  const groups = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups;
  assert.equal(groups.length, 50);
  assert.ok(groups.every((g) => g.itemCount === 400));
  const items = await allItems(repo, A, "live", groups[7].id, 100);
  assert.equal(items.length, 400);
  assert.equal(new Set(items.map((i) => i.id)).size, 400);
});

test("ids/cursores que não são UUID são recusados antes de chegar ao banco", async () => {
  const repo = new MemoryCatalogRepo();
  await imp(repo, A, base());
  const g = (await Q.listGroups({ repo, scope: A, kind: "live" })).groups[0];
  const bad = Buffer.from(JSON.stringify({ v: "'; DROP TABLE x;--", s: 1 })).toString("base64url");
  await assert.rejects(Q.listItems({ repo, scope: A, kind: "live", groupId: g.id, cursor: bad }), (e) => e.code === "INVALID_CURSOR");
  await assert.rejects(Q.getItem({ repo, scope: A, id: "p0" }), (e) => e.status === 404);
  assert.equal(await Q.resolvePlayable({ repo, scope: A, id: "p0" }), null);
  assert.equal(await Q.resolvePlayable({ repo, scope: A, id: "../../etc/passwd" }), null);
});

test("fonte cadastrada manualmente (itens já normalizados) usa o mesmo pipeline", async () => {
  const repo = new MemoryCatalogRepo();
  async function* manual() {
    yield { kind: "live", title: "Canal Manual", tvgName: "Canal Manual", tvgId: "", logo: "", group: "Abertos", url: "http://origem.example/a.m3u8" };
    yield { kind: "movie", title: "Filme M", tvgName: "Filme M", tvgId: "", logo: "", group: "Sem categoria", url: "http://origem.example/f.mp4" };
    yield { kind: "live", title: "Sem URL válida", tvgName: "x", tvgId: "", logo: "", group: "Abertos", url: "javascript:alert(1)" };
  }
  const r = await runImport({ repo, scope: { type: "source", id: "src-1" }, openItems: manual, encrypt });
  assert.equal(r.itemCount, 2);
  assert.equal(r.skipped, 1);
  const g = await Q.listGroups({ repo, scope: { type: "source", id: "src-1" }, kind: "live" });
  assert.deepEqual(g.groups.map((x) => [x.name, x.itemCount]), [["Abertos", 1]]);
});

test("erros viram códigos e mensagens fixas (nunca o texto original, que pode conter credenciais)", () => {
  const leak = "getaddrinfo ENOTFOUND http://user:SENHA@prov.example/get.php";
  for (const e of [Object.assign(new Error(leak), { code: "ENOTFOUND" }), Object.assign(new Error(leak), { code: "ORIGIN_ERROR" }), Object.assign(new Error(leak), { name: "AbortError" })]) {
    const r = safeErrorOf(e);
    assert.equal(r.code, "ORIGIN_UNAVAILABLE");
    assert.equal(/SENHA|user:|prov\.example/.test(JSON.stringify(r)), false);
  }
  assert.equal(safeErrorOf(new Error(leak)).code, "IMPORT_FAILED");
  assert.equal(safeErrorOf(Object.assign(new Error("x"), { code: "M3U_TOO_LARGE" })).code, "M3U_TOO_LARGE");
  assert.equal(safeErrorOf(null).code, "IMPORT_FAILED");
});
