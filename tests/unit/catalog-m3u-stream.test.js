import test from "node:test";
import assert from "node:assert/strict";
import { parseM3UStream, groupIdFor, seriesIdFor, titleSeparator, M3ULimitError, inBatches } from "../../src/modules/catalog/m3u-stream.js";
import { assignStableIds, fingerprintsOf } from "../../src/modules/catalog/stable-ids.js";

const collect = async (source, opts) => {
  const stats = {};
  const items = [];
  for await (const it of parseM3UStream(source, { ...opts, stats })) items.push(it);
  return { items, stats };
};
const chunksOf = (text, size) => {
  const buf = Buffer.from(text, "utf8");
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
};
const M3U = [
  "#EXTM3U",
  '#EXTINF:-1 tvg-id="globo.br" tvg-name="Globo Maranhão" tvg-logo="http://l/1.png" group-title="Globo",Globo Maranhão',
  "http://h/live/u/p/1.ts",
  '#EXTINF:-1 tvg-id="globo.br" tvg-name="Globo Brasília FHD" group-title="Globo",Globo Brasília FHD',
  "http://h/live/u/p/2.ts",
  '#EXTINF:-1 tvg-id="globo.br" tvg-name="Globo Brasília HD" group-title="Globo",Globo Brasília HD',
  "http://h/live/u/p/3.ts",
  '#EXTINF:-1 tvg-name="Canal sem grupo",Canal sem grupo',
  "http://h/live/u/p/4.ts",
].join("\n");

test("separa as três variantes de canal e preserva tvg-id repetido", async () => {
  const { items } = await collect([M3U]);
  assert.equal(items.length, 4);
  assert.deepEqual(items.slice(0, 3).map((i) => i.title), ["Globo Maranhão", "Globo Brasília FHD", "Globo Brasília HD"]);
  assert.ok(items.slice(0, 3).every((i) => i.group === "Globo" && i.tvgId === "globo.br" && i.kind === "live"));
  assert.equal(new Set(items.slice(0, 3).map((i) => i.url)).size, 3);
});

test("canal sem group-title vai para 'Sem categoria' e não é descartado", async () => {
  const { items } = await collect([M3U]);
  assert.equal(items[3].group, "Sem categoria");
});

test("CRLF, LF e CR isolado produzem o mesmo resultado", async () => {
  const lf = (await collect([M3U])).items;
  const crlf = (await collect([M3U.replaceAll("\n", "\r\n")])).items;
  const cr = (await collect([M3U.replaceAll("\n", "\r")])).items;
  assert.deepEqual(crlf, lf);
  assert.deepEqual(cr, lf);
});

test("resultado idêntico qualquer que seja o tamanho dos pedaços (inclui 1 byte e UTF-8 partido)", async () => {
  const ref = (await collect([M3U])).items;
  for (const size of [1, 2, 3, 7, 64, 1000]) {
    assert.deepEqual((await collect(chunksOf(M3U, size))).items, ref, `chunk=${size}`);
  }
});

test("BOM no início é aceito", async () => {
  const { items } = await collect(["\uFEFF" + M3U]);
  assert.equal(items.length, 4);
});

test("#EXTINF sem URL é descartado e NÃO rouba a URL do item seguinte", async () => {
  const text = [
    "#EXTM3U",
    '#EXTINF:-1 group-title="A",Sem URL',
    '#EXTINF:-1 group-title="B",Com URL',
    "http://h/live/x.ts",
  ].join("\n");
  const { items, stats } = await collect([text]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Com URL");
  assert.equal(items[0].group, "B");
  assert.equal(stats.skippedNoUrl, 1);
});

test("linhas #EXTVLCOPT entre #EXTINF e URL não quebram o vínculo", async () => {
  const text = '#EXTM3U\n#EXTINF:-1 group-title="A",Canal\n#EXTVLCOPT:http-user-agent=x\nhttp://h/live/1.ts\n';
  const { items } = await collect([text]);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "http://h/live/1.ts");
});

test("URL inválida é contada e ignorada; linhas soltas e lixo não geram itens", async () => {
  const text = '#EXTM3U\nlixo solto\n#EXTINF:-1 group-title="A",Ruim\nnao-eh-url\n#EXTINF:-1 group-title="A",Bom\nhttp://h/1.ts\n';
  const { items, stats } = await collect([text]);
  assert.equal(items.length, 1);
  assert.equal(stats.skippedBadUrl, 1);
});

test("#EXTINF colado ao fim da linha anterior é separado", async () => {
  const text = '#EXTM3U\n#EXTINF:-1 group-title="A",Um\nhttp://h/1.ts#EXTINF:-1 group-title="A",Dois\nhttp://h/2.ts\n';
  const { items } = await collect([text]);
  assert.deepEqual(items.map((i) => i.title), ["Um", "Dois"]);
  assert.equal(items[0].url, "http://h/1.ts");
});

test("vírgula dentro de atributo entre aspas não corta o título", async () => {
  const line = '#EXTINF:-1 tvg-name="Rock, Pop e Jazz" group-title="Música, Variedades",Rock, Pop e Jazz';
  assert.equal(line.slice(titleSeparator(line) + 1), "Rock, Pop e Jazz");
  const { items } = await collect([`#EXTM3U\n${line}\nhttp://h/1.ts\n`]);
  assert.equal(items[0].group, "Música, Variedades");
  assert.equal(items[0].tvgName, "Rock, Pop e Jazz");
});

test("classifica canais, filmes e séries (temporada/episódio) por tipo", async () => {
  const text = [
    "#EXTM3U",
    '#EXTINF:-1 group-title="CANAIS | ESPORTES",ESPN',
    "http://h/live/u/p/1.ts",
    '#EXTINF:-1 group-title="FILMES | AÇÃO",Duro de Matar (1988)',
    "http://h/movie/u/p/2.mp4",
    '#EXTINF:-1 tvg-name="José do Egito S01 José do Egito - S01E02 - Episódio 2" group-title="SÉRIES | NOVELAS",José do Egito S01 José do Egito - S01E02 - Episódio 2',
    "http://h/series/u/p/3.mp4",
  ].join("\n");
  const { items } = await collect([text]);
  assert.deepEqual(items.map((i) => i.kind), ["live", "movie", "series"]);
  assert.equal(items[2].seriesTitle, "José do Egito");
  assert.equal(items[2].season, 1);
  assert.equal(items[2].episode, 2);
});

test("limites: tamanho total, linha gigante e nº de itens", async () => {
  await assert.rejects(collect(chunksOf(M3U, 50), { limits: { maxBytes: 100 } }), (e) => e instanceof M3ULimitError && e.code === "M3U_TOO_LARGE");
  await assert.rejects(collect(["#EXTM3U\n" + "x".repeat(5000)], { limits: { maxLineLength: 1000 } }), (e) => e.code === "M3U_LINE_TOO_LONG");
  await assert.rejects(collect([M3U], { limits: { maxItems: 2 } }), (e) => e.code === "M3U_TOO_MANY_ITEMS");
});

test("resposta que não é M3U (ex.: página HTML) é rejeitada", async () => {
  await assert.rejects(collect(["<html><body>Erro 403</body></html>"]), (e) => e.code === "M3U_INVALID");
});

test("playlist com cabeçalho e sem itens é válida e vazia", async () => {
  const { items, stats } = await collect(["#EXTM3U\n"]);
  assert.equal(items.length, 0);
  assert.equal(stats.sawHeader, true);
});

test("id de pasta é determinístico, separa tipo e fonte, e ignora caixa/espaços", () => {
  const a = groupIdFor("src1", "live", "Globo");
  assert.equal(a, groupIdFor("src1", "live", "  globo "));
  assert.notEqual(a, groupIdFor("src1", "movie", "Globo"));
  assert.notEqual(a, groupIdFor("src2", "live", "Globo"));
  assert.equal(seriesIdFor("s", "José do Egito"), seriesIdFor("s", "josé do egito"));
});

test("inBatches agrupa sem perder itens", async () => {
  async function* gen() { for (let i = 0; i < 10; i++) yield i; }
  const out = [];
  for await (const b of inBatches(gen(), 4)) out.push(b.length);
  assert.deepEqual(out, [4, 4, 2]);
});

/* ---------- ids estáveis ---------- */
const prevFrom = (items, ids) => items.map((it, i) => ({ id: ids[i], ...fingerprintsOf(it) }));

test("ids estáveis: reordenar a playlist preserva todos os ids", async () => {
  const v1 = (await collect([M3U])).items;
  const ids = v1.map((_, i) => `id-${i}`);
  const v2 = [...v1].reverse();
  const r = assignStableIds(prevFrom(v1, ids), v2);
  assert.deepEqual(r.ids, [...ids].reverse());
  assert.equal(r.created, 0);
});

test("ids estáveis: URL/token mudou mas o canal é inequívoco => mesmo id", async () => {
  const v1 = (await collect([M3U])).items;
  const ids = v1.map((_, i) => `id-${i}`);
  const v2 = v1.map((it) => ({ ...it, url: it.url.replace("/u/p/", "/novo/token/") }));
  assert.deepEqual(assignStableIds(prevFrom(v1, ids), v2).ids, ids);
});

test("ids estáveis: nome ambíguo NÃO reaproveita id quando a URL muda", () => {
  const base = { kind: "live", group: "G", tvgName: "Canal X", tvgId: "x", title: "Canal X" };
  const v1 = [{ ...base, url: "http://h/1" }, { ...base, url: "http://h/2" }];
  const v2 = [{ ...base, url: "http://h/9" }, { ...base, url: "http://h/8" }];
  const r = assignStableIds(prevFrom(v1, ["A", "B"]), v2);
  assert.deepEqual(r.ids, [null, null]);
  assert.equal(r.created, 2);
});

test("ids estáveis: entradas idênticas repetidas mantêm ids distintos e na ordem", () => {
  const dup = { kind: "live", group: "G", tvgName: "Rep", tvgId: "", title: "Rep", url: "http://h/1" };
  const r = assignStableIds(prevFrom([dup, dup], ["A", "B"]), [dup, dup]);
  assert.deepEqual(r.ids, ["A", "B"]);
});

test("ids estáveis: item removido some; item novo recebe null; um id nunca é usado duas vezes", () => {
  const a = { kind: "live", group: "G", tvgName: "A", tvgId: "", title: "A", url: "http://h/a" };
  const b = { kind: "live", group: "G", tvgName: "B", tvgId: "", title: "B", url: "http://h/b" };
  const c = { kind: "live", group: "G", tvgName: "C", tvgId: "", title: "C", url: "http://h/c" };
  const r = assignStableIds(prevFrom([a, b], ["A", "B"]), [b, c]);
  assert.deepEqual(r.ids, ["B", null]);
  assert.equal(new Set(r.ids.filter(Boolean)).size, r.ids.filter(Boolean).length);
});

test("ids estáveis: mudar de pasta não reaproveita o id (mantém posição original por pasta)", () => {
  const a = { kind: "live", group: "Esportes", tvgName: "A", tvgId: "", title: "A", url: "http://h/a" };
  const moved = { ...a, group: "Abertos" };
  const r = assignStableIds(prevFrom([a], ["A"]), [moved]);
  assert.deepEqual(r.ids, [null]);
});
