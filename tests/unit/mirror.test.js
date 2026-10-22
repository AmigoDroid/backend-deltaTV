import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Sem banco e sem Express: o painel Xtream é simulado por um servidor local e os handlers são chamados direto.
process.env.ALLOW_PRIVATE_SOURCES = "true";
process.env.PUBLIC_BASE_URL = "https://espelho.example.com";
const H = await import("../../src/modules/mirror/mirror.handlers.js");
const { MIRROR_PASS, deliveryModeOf } = await import("../../src/modules/mirror/mode.js");
const { m3uMirrorRewriter } = await import("../../src/modules/mirror/m3u-rewrite.js");
const { clearXtreamCache } = await import("../../src/modules/xtream/xtream.client.js");

const REAL = { username: "991776", password: "048342" };
const MOVIE = Buffer.alloc(100_000, "A");
let panel, panelPort, mirror, mirrorPort, mode = "proxy", hits = [];

before(async () => {
  panel = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push({ path: u.pathname, ua: req.headers["user-agent"], range: req.headers.range });
    const ok = (p) => p === REAL.username;
    if (u.pathname === "/player_api.php") {
      if (u.searchParams.get("username") !== REAL.username || u.searchParams.get("password") !== REAL.password) {
        return res.end(JSON.stringify({ user_info: { auth: 0 } }));
      }
      res.setHeader("content-type", "application/json");
      const action = u.searchParams.get("action");
      if (!action) {
        return res.end(JSON.stringify({
          user_info: { username: REAL.username, password: REAL.password, auth: 1, status: "Active", max_connections: "2" },
          server_info: { url: "127.0.0.1", port: String(panelPort), https_port: "443", server_protocol: "http" },
        }));
      }
      return res.end(JSON.stringify([{ name: "Agro +", stream_id: 1946286, action }]));
    }
    if (u.pathname === "/get.php") {
      res.setHeader("content-type", "audio/x-mpegurl");
      const b = `http://127.0.0.1:${panelPort}`;
      return res.end(
        `#EXTM3U\n#EXTINF:-1 tvg-id="80",Agro +\n${b}/live/${REAL.username}/${REAL.password}/1946286.ts\n` +
        `#EXTINF:-1,Filme\n${b}/movie/${REAL.username}/${REAL.password}/55.mp4\n` +
        `#EXTINF:-1,Outro host\nhttp://outro.example/live/${REAL.username}/${REAL.password}/9.ts\n` +
        `#EXTINF:-1 tvg-logo="http://logos.example/a.png",Sem credencial\nhttp://cdn.example/free/stream.m3u8\n`,
      );
    }
    const m = u.pathname.match(/^\/(?:(live|movie|series)\/)?([^/]+)\/([^/]+)\/(\d+)\.(\w+)$/);
    if (m && ok(m[2]) && m[3] === REAL.password) {
      const [, kind, , , id, ext] = m;
      if (id === "404") { res.statusCode = 404; return res.end("nope"); }
      if (ext === "m3u8") { res.statusCode = 302; res.setHeader("location", `/hls/abc123/index.m3u8`); return res.end(); }
      if (kind === "movie") {
        res.setHeader("content-type", "video/mp4");
        res.setHeader("accept-ranges", "bytes");
        const r = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        if (r) {
          const a = +r[1], b = r[2] ? +r[2] : MOVIE.length - 1;
          res.statusCode = 206;
          res.setHeader("content-range", `bytes ${a}-${b}/${MOVIE.length}`);
          return res.end(MOVIE.subarray(a, b + 1));
        }
        return res.end(MOVIE);
      }
      res.setHeader("content-type", "video/mp2t");
      res.write("TS-1|"); return setTimeout(() => res.end("TS-2"), 20);
    }
    if (u.pathname === "/hls/abc123/index.m3u8") {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\n/hls/abc123/seg2.ts\n");
    }
    if (u.pathname.startsWith("/hls/abc123/seg")) { res.setHeader("content-type", "video/mp2t"); return res.end("SEGMENT:" + u.pathname); }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => panel.listen(0, "127.0.0.1", r));
  panelPort = panel.address().port;

  // "Servidor": mesmo roteamento da rota espelho, sem banco (ctx fixo).
  mirror = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const ctx = {
      token: "tok.en.jwt", mode, publicBase: process.env.PUBLIC_BASE_URL, recheck: async () => true,
      cred: { baseUrl: `http://127.0.0.1:${panelPort}`, ...REAL },
    };
    const q = Object.fromEntries(u.searchParams);
    try {
      let m;
      if (u.pathname === "/player_api.php") await H.playerApi(ctx, req, res, q);
      else if (u.pathname === "/get.php") await H.getPhp(ctx, req, res, q);
      else if ((m = u.pathname.match(/^\/(live|movie|series)\/[^/]+\/[^/]+\/([^/]+)$/))) await H.mediaStream(ctx, req, res, m[1], m[2]);
      else if ((m = u.pathname.match(/^\/hls\/[^/]+\/([^/]+)$/))) await H.hlsPart(ctx, req, res, m[1]);
      else { res.statusCode = 404; res.end(); }
    } catch (e) {
      res.statusCode = e.status ?? 500; res.end(JSON.stringify({ code: e.code, message: e.message }));
    }
  });
  await new Promise((r) => mirror.listen(0, "127.0.0.1", r));
  mirrorPort = mirror.address().port;
});
after(() => { panel.close(); mirror.close(); panel.closeAllConnections?.(); mirror.closeAllConnections?.(); });

const get = async (path, headers) => {
  const r = await fetch(`http://127.0.0.1:${mirrorPort}${path}`, { headers, redirect: "manual" });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

test("modo de entrega: lista própria = proxy; parceria segue o provedor", () => {
  assert.equal(deliveryModeOf({ playlistUrlEnc: "x" }), "proxy");
  assert.equal(deliveryModeOf({ PartnerProvider: { deliveryMode: "proxy" } }), "proxy");
  assert.equal(deliveryModeOf({ PartnerProvider: { deliveryMode: "redirect" } }), "redirect");
  assert.equal(deliveryModeOf({}), "redirect");
});

test("PROXY player_api: auth reescrita para o espelho; credencial real não vaza", async () => {
  mode = "proxy"; clearXtreamCache();
  const r = await get("/player_api.php?username=x&password=y");
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.equal(j.user_info.username, "tok.en.jwt");
  assert.equal(j.user_info.password, MIRROR_PASS);
  assert.equal(j.user_info.max_connections, "2");
  assert.equal(j.server_info.url, "espelho.example.com");
  assert.equal(j.server_info.port, "443");
  assert.equal(j.server_info.server_protocol, "https");
  assert.ok(!r.text.includes(REAL.password));
  assert.equal(r.headers.get("content-length"), String(Buffer.byteLength(r.text)));
});

test("PROXY player_api com action: lista servida em fluxo, sem alteração", async () => {
  mode = "proxy";
  const r = await get("/player_api.php?username=x&password=y&action=get_live_streams");
  assert.deepEqual(JSON.parse(r.text), [{ name: "Agro +", stream_id: 1946286, action: "get_live_streams" }]);
});

test("PROXY envia User-Agent ao painel", async () => {
  mode = "proxy"; hits = [];
  await get("/player_api.php?username=x&password=y&action=get_vod_categories");
  assert.ok(hits.at(-1).ua);
});

test("REDIRECT player_api: 302 para o painel", async () => {
  mode = "redirect";
  const r = await get("/player_api.php?username=x&password=y&action=get_live_streams");
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.port, String(panelPort));
  assert.equal(loc.searchParams.get("username"), REAL.username);
  assert.equal(loc.searchParams.get("action"), "get_live_streams");
});

test("PROXY filme: corpo completo e Range/206 (seek)", async () => {
  mode = "proxy"; clearXtreamCache();
  const full = await get("/movie/t/m/55.mp4");
  assert.equal(full.status, 200);
  assert.equal(full.text.length, MOVIE.length);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  const part = await get("/movie/t/m/55.mp4", { range: "bytes=10-19" });
  assert.equal(part.status, 206);
  assert.equal(part.text, "AAAAAAAAAA");
  assert.equal(part.headers.get("content-range"), `bytes 10-19/${MOVIE.length}`);
});

test("PROXY canal ao vivo .ts e sem extensão (padrão ts)", async () => {
  mode = "proxy";
  assert.equal((await get("/live/t/m/1946286.ts")).text, "TS-1|TS-2");
  assert.equal((await get("/live/t/m/1946286")).text, "TS-1|TS-2");
});

test("PROXY HLS: segue o redirect do painel, reescreve segmentos relativos e absolutos e serve os segmentos", async () => {
  mode = "proxy";
  const pl = await get("/live/t/m/7.m3u8");
  assert.equal(pl.status, 200);
  assert.match(pl.headers.get("content-type"), /mpegurl/);
  const segs = pl.text.split("\n").filter((l) => l.startsWith("/hls/"));
  assert.equal(segs.length, 2);
  assert.ok(!pl.text.includes("127.0.0.1"));
  const s1 = await get(segs[0]);
  assert.equal(s1.text, "SEGMENT:/hls/abc123/seg1.ts");
  const s2 = await get(segs[1]);
  assert.equal(s2.text, "SEGMENT:/hls/abc123/seg2.ts");
});

test("PROXY: blob HLS adulterado -> 404", async () => {
  mode = "proxy";
  assert.equal((await get("/hls/t/v1.AAAA.BBBB.CCCC")).status, 404);
  assert.equal((await get("/hls/t/lixo")).status, 404);
});

test("REDIRECT stream: 302 direto para o painel", async () => {
  mode = "redirect"; clearXtreamCache();
  const r = await get("/movie/t/m/55.mp4");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), new RegExp(`:${panelPort}/movie/${REAL.username}/${REAL.password}/55\\.mp4$`));
});

test("origem 404 -> 404; id inválido -> 404", async () => {
  mode = "proxy";
  assert.equal((await get("/movie/t/m/404.mp4")).status, 404);
  assert.equal((await get("/movie/t/m/abc.mp4")).status, 404);
});

test("PROXY get.php: M3U com URLs apontando para o espelho (só as do painel)", async () => {
  mode = "proxy";
  const r = await get("/get.php?username=x&password=y&type=m3u_plus&output=ts");
  const lines = r.text.split("\n");
  assert.ok(lines.includes(`https://espelho.example.com/live/tok.en.jwt/${MIRROR_PASS}/1946286.ts`));
  assert.ok(lines.includes(`https://espelho.example.com/movie/tok.en.jwt/${MIRROR_PASS}/55.mp4`));
  // Qualquer host cuja URL carregue a credencial real é espelhado (o stream pode ficar em outro servidor do painel)…
  assert.ok(lines.includes(`https://espelho.example.com/live/tok.en.jwt/${MIRROR_PASS}/9.ts`));
  // …e URLs sem a credencial passam intactas.
  assert.ok(lines.includes("http://cdn.example/free/stream.m3u8"));
  assert.ok(!r.text.includes(REAL.password));
  assert.ok(!r.text.includes(`127.0.0.1:${panelPort}`));
});

test("m3uMirrorRewriter: lida com chunk partido no meio da linha e UTF-8", async () => {
  const rw = m3uMirrorRewriter({ username: "u", password: "p", base: "https://e.com/", mirrorUser: "T", mirrorPass: "m" });
  const out = [];
  rw.on("data", (d) => out.push(d.toString()));
  const input = Buffer.from("#EXTINF:-1,Ação ▶️\nhttp://h/live/u/p/1.ts\nhttp://h/u/p/2");
  for (let i = 0; i < input.length; i += 7) rw.write(input.subarray(i, i + 7));
  rw.end();
  await new Promise((r) => rw.on("end", r));
  assert.equal(out.join(""), "#EXTINF:-1,Ação ▶️\nhttps://e.com/live/T/m/1.ts\nhttps://e.com/T/m/2");
});

test("origem privada é bloqueada quando ALLOW_PRIVATE_SOURCES não está ligado", async () => {
  process.env.ALLOW_PRIVATE_SOURCES = "false";
  try {
    mode = "redirect";
    assert.equal((await get("/movie/t/m/55.mp4")).status, 502);
    mode = "proxy";
    const r = await get("/player_api.php?username=x&password=y&action=get_live_streams");
    assert.ok(r.status >= 400);
  } finally {
    process.env.ALLOW_PRIVATE_SOURCES = "true";
  }
});
