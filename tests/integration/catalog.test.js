/**
 * Integração do catálogo persistente (exige PostgreSQL). Mesmo ambiente do licensing.test.js:
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/iptv_licensing_test npm test
 * O banco informado é DESTRUÍDO e recriado. Imprime uma linha "CATALOG_METRICS {...}" com as medições de desempenho.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";

const DB = process.env.DATABASE_URL_TEST;
const suite = DB ? describe : describe.skip;
const ADMIN = { email: "root@test.local", password: "senha-super-segura-123" };
const PERF_ITEMS = Number(process.env.CATALOG_PERF_ITEMS ?? 50_000);

suite("Catálogo persistente (integração)", () => {
  let base, server, M, sequelize, adminToken, plans, fake, providerBase, runtime;
  let playlist = ""; // corpo que o provedor falso serve em /list.m3u
  let providerFails = false;

  const cli = (...args) => execFileSync("npx", ["sequelize-cli", ...args], {
    env: { ...process.env, DATABASE_URL: DB, NODE_ENV: "test", ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: "pipe",
  });
  async function api(method, path, { token, body } = {}) {
    const res = await fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* sem corpo */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  let macSeq = 0;
  const mac = () => `CC:DD:EE:00:${String(Math.floor(++macSeq / 256)).padStart(2, "0")}:${(macSeq % 256).toString(16).padStart(2, "0").toUpperCase()}`;
  const m3u = (rows) => `#EXTM3U\r\n${rows.map((r) => `#EXTINF:-1 tvg-id="${r.tvgId ?? ""}" tvg-name="${r.name}" tvg-logo="" group-title="${r.group ?? ""}",${r.name}\r\n${r.url}`).join("\r\n")}\r\n`;
  const L = (name, group, n, tvgId) => ({ name, group: group ? `CANAIS | ${group}` : "", url: `http://127.0.0.1:${fake.address().port}/live/u1/p1/${n}.ts`, tvgId });
  const M_ = (name, group, n) => ({ name, group: `FILMES | ${group}`, url: `http://127.0.0.1:${fake.address().port}/movie/u1/p1/${n}.mp4` });
  const E = (serie, s, e, n) => ({ name: `${serie} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`, group: "SÉRIES | NOVELAS", url: `http://127.0.0.1:${fake.address().port}/series/u1/p1/${n}.mp4` });

  async function newDevice(listPath = "/list.m3u") {
    const plan = plans[0];
    const lic = await api("POST", "/api/v1/admin/licenses", { token: adminToken, body: { planId: plan.id, customer: { name: "Cliente Catálogo" } } });
    assert.equal(lic.status, 201, lic.text);
    const m = mac();
    const act = await api("POST", "/api/v1/client/activate/license", { body: { code: lic.body.code, mac: m } });
    assert.equal(act.status, 201, act.text);
    const token = act.body.tokens.accessToken;
    const cfg = await api("POST", "/api/v1/client/configure/playlist", { token, body: { name: "Minha lista", url: `${providerBase}${listPath}` } });
    assert.equal(cfg.status, 200, cfg.text);
    return { token, mac: m, licenseId: lic.body.license.id, activationId: act.body.activationId ?? cfg.body.activationId };
  }
  const cat = (dev, path) => api("GET", `/api/v1/client/catalog/${path}${path.includes("?") ? "&" : "?"}sourceId=me`, { token: dev.token });

  /** Espera o catálogo ficar pronto (a importação roda em segundo plano). Devolve quantas tentativas 503 houve. */
  async function untilReady(dev, kind = "live", timeoutMs = 60_000) {
    const t0 = Date.now(); let preparing = 0;
    for (;;) {
      const r = await cat(dev, `groups?kind=${kind}`);
      if (r.status === 200) return { r, preparing };
      assert.equal(r.status, 503, r.text);
      assert.equal(r.body.code, "CATALOG_PREPARING");
      assert.ok(r.headers.get("retry-after"), "503 deve trazer Retry-After");
      preparing++;
      assert.ok(Date.now() - t0 < timeoutMs, "importação demorou demais");
      await new Promise((res) => setTimeout(res, 150));
    }
  }
  const ctxOf = async (dev) => ({ scope: { type: "activation", id: dev.activationId }, activation: await M.Activation.findByPk(dev.activationId) });

  before(async () => {
    process.env.DATABASE_URL = DB;
    process.env.NODE_ENV = "test";
    process.env.RATE_LIMIT_DISABLED = "true";
    process.env.ALLOW_PRIVATE_SOURCES = "true";
    fake = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/list.m3u") {
        if (providerFails) { res.statusCode = 500; return res.end("erro"); }
        res.setHeader("content-type", "audio/x-mpegurl");
        return res.end(playlist);
      }
      if (/^\/(live|movie|series)\//.test(u.pathname)) { res.setHeader("content-type", "video/mp2t"); return res.end("TSDATA"); }
      res.statusCode = 404; res.end();
    }).listen(0);
    providerBase = `http://127.0.0.1:${fake.address().port}`;
    cli("db:migrate:undo:all");
    cli("db:migrate");
    cli("db:seed:all");
    ({ sequelize, ...M } = await import("../../src/db/models/index.js"));
    runtime = await import("../../src/modules/catalog/catalog.runtime.js");
    const { createApp } = await import("../../src/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api("POST", "/api/v1/auth/login", { body: ADMIN });
    assert.equal(login.status, 200, login.text);
    adminToken = login.body.accessToken;
    plans = (await api("GET", "/api/v1/admin/licenses/plans", { token: adminToken })).body.data;
  });
  after(async () => { server?.close(); fake?.close(); await sequelize?.close(); });

  test("TV ao vivo → pastas → canais → reprodução, com variantes independentes e sem vazar a origem", async () => {
    playlist = m3u([
      L("Globo Maranhão", "Globo", 1, "globo"), L("Globo Brasília FHD", "Globo", 2, "globo"), L("Globo Brasília HD", "Globo", 3, "globo"),
      L("ESPN", "Esportes", 4), L("Canal Solto", "", 5),
      M_("Duro de Matar", "AÇÃO", 6), M_("Rambo", "AÇÃO", 7),
      E("Novela X", 1, 2, 8), E("Novela X", 1, 1, 9), E("Novela X", 2, 1, 10),
    ]);
    const dev = await newDevice();
    const first = await cat(dev, "groups?kind=live");
    assert.equal(first.status, 503, "a primeira consulta não espera o download");
    const { r: groups } = await untilReady(dev);
    assert.deepEqual(groups.body.groups.map((g) => [g.name, g.itemCount]), [["CANAIS | Globo", 3], ["CANAIS | Esportes", 1], ["Sem categoria", 1]]);

    const gid = groups.body.groups[0].id;
    const p1 = await cat(dev, `items?kind=live&groupId=${gid}&pageSize=2`);
    assert.equal(p1.status, 200, p1.text);
    assert.equal(p1.body.items.length, 2);
    assert.ok(p1.body.nextCursor);
    const p2 = await cat(dev, `items?kind=live&groupId=${gid}&pageSize=2&cursor=${p1.body.nextCursor}`);
    const titles = [...p1.body.items, ...p2.body.items].map((i) => i.title);
    assert.deepEqual(titles, ["Globo Maranhão", "Globo Brasília FHD", "Globo Brasília HD"]);
    assert.equal(new Set([...p1.body.items, ...p2.body.items].map((i) => i.id)).size, 3);
    assert.equal(p2.body.nextCursor, null);

    assert.equal(/127\.0\.0\.1|u1\/p1|originEnc/.test(p1.text + p2.text + groups.text), false, "origem e credenciais não saem do servidor");

    const tok = (await api("POST", "/api/v1/client/play-token", { token: dev.token })).body.playToken;
    const item = p1.body.items[0];
    assert.match(item.srcVideo, new RegExp(`^/api/v1/play/me/${item.id}\\.ts$`));
    const played = await fetch(`${base}${item.srcVideo}?t=${tok}`);
    assert.equal(played.status, 200);
    assert.equal(await played.text(), "TSDATA");

    const movies = await cat(dev, "groups?kind=movie");
    const mv = await cat(dev, `items?kind=movie&groupId=${movies.body.groups[0].id}`);
    assert.deepEqual(mv.body.items.map((i) => i.title), ["Duro de Matar", "Rambo"]);

    const series = await cat(dev, "series");
    assert.equal(series.body.series.length, 1);
    const sid = series.body.series[0].id;
    const seasons = await cat(dev, `series/${sid}/seasons`);
    assert.deepEqual(seasons.body.seasons, [{ season: 1, episodeCount: 2 }, { season: 2, episodeCount: 1 }]);
    const eps = await cat(dev, `series/${sid}/episodes?season=1`);
    assert.deepEqual(eps.body.episodes.map((e) => e.episode), [1, 2], "ordenados por número, não pela ordem da playlist");

    const st = await cat(dev, "status");
    assert.equal(st.body.state, "ready");
    assert.equal(st.body.itemCount, 10);
  });

  test("catálogo persiste e é recuperável por outro repositório (equivale a reiniciar o backend)", async () => {
    playlist = m3u([L("A", "G", 1), L("B", "G", 2)]);
    const dev = await newDevice();
    await untilReady(dev);
    const { createPgCatalogRepo } = await import("../../src/modules/catalog/pg.repo.js");
    const fresh = createPgCatalogRepo(sequelize);
    const active = await fresh.activeImport({ type: "activation", id: dev.activationId });
    assert.equal(active.itemCount, 2);
  });

  test("reimportar com a ordem trocada mantém ids e reprodução; cursor antigo continua na versão antiga", async () => {
    const rows = [L("C1", "G", 1), L("C2", "G", 2), L("C3", "G", 3), L("C4", "G", 4)];
    playlist = m3u(rows);
    const dev = await newDevice();
    const { r: g } = await untilReady(dev);
    const gid = g.body.groups[0].id;
    const before = await cat(dev, `items?kind=live&groupId=${gid}&pageSize=2`);
    const allBefore = new Map([...before.body.items, ...(await cat(dev, `items?kind=live&groupId=${gid}&pageSize=2&cursor=${before.body.nextCursor}`)).body.items].map((i) => [i.title, i.id]));

    playlist = m3u([...rows].reverse());
    const result = await runtime.startImport(await ctxOf(dev));
    assert.equal(result.newIds, 0, "nenhum id novo: todos os itens foram reconhecidos");

    const stale = await cat(dev, `items?kind=live&groupId=${gid}&pageSize=2&cursor=${before.body.nextCursor}`);
    assert.equal(stale.status, 200, "o cursor da versão anterior ainda funciona");
    assert.equal(stale.body.outdated, true);
    assert.deepEqual(stale.body.items.map((i) => i.title), ["C3", "C4"], "mesma ordem da página 1");

    const fresh1 = await cat(dev, `items?kind=live&groupId=${gid}&pageSize=10`);
    assert.deepEqual(fresh1.body.items.map((i) => i.title), ["C4", "C3", "C2", "C1"]);
    for (const it of fresh1.body.items) assert.equal(it.id, allBefore.get(it.title), "mesmo item, mesmo id");
  });

  test("falha do provedor mantém a última versão válida; trocar a lista da TV descarta a antiga", async () => {
    playlist = m3u([L("Antigo 1", "Velha", 1), L("Antigo 2", "Velha", 2)]);
    const dev = await newDevice();
    await untilReady(dev);
    providerFails = true;
    const failed = await runtime.startImport(await ctxOf(dev));
    providerFails = false;
    assert.equal(failed, null);
    assert.equal((await cat(dev, "groups?kind=live")).status, 200, "continua servindo a versão anterior");
    const last = await M.sequelize.query("SELECT status, error_code FROM catalog_imports WHERE activation_id = :id ORDER BY created_at DESC LIMIT 1", { replacements: { id: dev.activationId }, type: "SELECT" });
    assert.equal(last[0].status, "failed");
    assert.equal(/user|SENHA|127\.0\.0\.1/.test(JSON.stringify(last)), false);

    playlist = m3u([L("Novo 1", "Nova", 3)]);
    const cfg = await api("POST", "/api/v1/client/configure/playlist", { token: dev.token, body: { name: "Outra lista", url: `${providerBase}/list.m3u?v=2` } });
    assert.equal(cfg.status, 200, cfg.text);
    const { r } = await untilReady(dev);
    assert.deepEqual(r.body.groups.map((x) => x.name), ["CANAIS | Nova"], "a lista antiga não aparece mais");
  });

  test("isolamento: uma TV não enxerga nem reproduz itens de outra, nem fontes não autorizadas", async () => {
    playlist = m3u([L("Só da A", "GA", 1)]);
    const a = await newDevice();
    playlist = m3u([L("Só da B", "GB", 2)]);
    const b = await newDevice();
    const { r: ga } = await untilReady(a);
    const { r: gb } = await untilReady(b);
    assert.notEqual(ga.body.groups[0].id, gb.body.groups[0].id);
    const itemA = (await cat(a, `items?kind=live&groupId=${ga.body.groups[0].id}`)).body.items[0];
    const cross = await cat(b, `items?kind=live&groupId=${ga.body.groups[0].id}`);
    assert.deepEqual(cross.body.items, [], "pasta de outra TV não revela nada");
    const tokB = (await api("POST", "/api/v1/client/play-token", { token: b.token })).body.playToken;
    assert.equal((await fetch(`${base}${itemA.srcVideo}?t=${tokB}`)).status, 404, "id de outra TV não reproduz");
    const other = await api("GET", "/api/v1/client/catalog/groups?kind=live&sourceId=7c9e6679-7425-40de-944b-e07fc1f90ae7", { token: a.token });
    assert.equal(other.status, 404);
    assert.equal((await api("GET", "/api/v1/client/catalog/groups?kind=live&sourceId=me")).status, 401, "sem sessão não há catálogo");
    assert.equal((await api("GET", "/api/v1/client/catalog/items?kind=live&sourceId=me", { token: a.token })).status, 400, "live exige a pasta");
  });

  test("licença bloqueada durante a sessão: catálogo e reprodução passam a ser negados", async () => {
    playlist = m3u([L("X", "G", 1)]);
    const dev = await newDevice();
    const { r } = await untilReady(dev);
    const item = (await cat(dev, `items?kind=live&groupId=${r.body.groups[0].id}`)).body.items[0];
    const tok = (await api("POST", "/api/v1/client/play-token", { token: dev.token })).body.playToken;
    assert.equal((await fetch(`${base}${item.srcVideo}?t=${tok}`)).status, 200);
    const rev = await api("POST", `/api/v1/admin/licenses/${dev.licenseId}/block`, { token: adminToken, body: { reason: "teste de bloqueio durante a sessão" } });
    assert.ok([200, 204].includes(rev.status), rev.text);
    assert.ok([401, 403].includes((await cat(dev, "groups?kind=live")).status));
    assert.ok([401, 403].includes((await fetch(`${base}${item.srcVideo}?t=${tok}`)).status));
  });

  test(`desempenho com ${PERF_ITEMS} itens (registra métricas)`, async () => {
    const groups = 100;
    const rows = Array.from({ length: PERF_ITEMS }, (_, i) => {
      const k = i % 10;
      if (k < 6) return L(`Canal ${i} HD`, `G${i % groups}`, i + 1, `c${i % 997}`);
      if (k < 9) return M_(`Filme ${i} (2020)`, `CAT${i % 40}`, i + 1);
      return E(`Serie ${Math.floor(i / 10) % 800}`, 1, (i % 20) + 1, i + 1);
    });
    playlist = m3u(rows);
    const bytes = Buffer.byteLength(playlist);
    const dev = await newDevice();
    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    const t0 = Date.now();
    const { r: groupsRes } = await untilReady(dev, "live", 300_000);
    const importMs = Date.now() - t0;
    clearInterval(sampler);

    const timed = async (path) => { const s = process.hrtime.bigint(); const r = await cat(dev, path); return { r, ms: Number(process.hrtime.bigint() - s) / 1e6, bytes: Buffer.byteLength(r.text) }; };
    const g = await timed("groups?kind=live");
    const gid = groupsRes.body.groups[0].id;
    const p1 = await timed(`items?kind=live&groupId=${gid}&pageSize=40`);
    const p2 = await timed(`items?kind=live&groupId=${gid}&pageSize=40&cursor=${p1.r.body.nextCursor}`);
    const search = await timed(`items?kind=movie&q=Filme%2012&pageSize=40`);
    const legacy = await api("GET", "/api/v1/client/catalog?sourceId=me", { token: dev.token }); // rota antiga, para comparação
    const m = {
      itens: PERF_ITEMS, tamanhoPlaylistMB: +(bytes / 1048576).toFixed(1), importacaoMs: importMs, picoRssMB: +(peak / 1048576).toFixed(0), rssAntesMB: +(rss0 / 1048576).toFixed(0),
      pastasMs: +g.ms.toFixed(1), pastasBytes: g.bytes, primeiraPaginaMs: +p1.ms.toFixed(1), primeiraPaginaBytes: p1.bytes, segundaPaginaMs: +p2.ms.toFixed(1),
      buscaFilmesMs: +search.ms.toFixed(1), rotaAntigaBytes: Buffer.byteLength(legacy.text), rotaAntigaStatus: legacy.status,
    };
    console.log(`CATALOG_METRICS ${JSON.stringify(m)}`);
    assert.equal(groupsRes.body.groups.length, groups);
    assert.equal(p1.r.body.items.length, 40);
    assert.ok(p1.ms < 2000 && p2.ms < 2000, "páginas devem responder rápido mesmo com catálogo grande");
    assert.ok(p1.bytes < 20_000, "a primeira página é pequena");
  });
});
