import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.ALLOW_PRIVATE_SOURCES = "true";
const { xtreamFromUrl, probeAccount, forgetProbe, xtreamOrigin } = await import("../../src/modules/xtream/xtream.service.js");

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
});

test("xtreamFromUrl entende get.php, /playlist/ e /live/", () => {
  assert.deepEqual(xtreamFromUrl("http://h.xyz:8080/get.php?username=u1&password=p%401&type=m3u_plus"), { baseUrl: "http://h.xyz:8080", username: "u1", password: "p@1" });
  assert.deepEqual(xtreamFromUrl("http://h.xyz/playlist/991776/abc/m3u_plus"), { baseUrl: "http://h.xyz", username: "991776", password: "abc" });
  assert.deepEqual(xtreamFromUrl("https://h.xyz/live/u/p/12.ts"), { baseUrl: "https://h.xyz", username: "u", password: "p" });
  assert.equal(xtreamFromUrl("http://h.xyz/lista.m3u"), null);
  assert.equal(xtreamFromUrl("lixo"), null);
});

test("xtreamOrigin recusa credenciais na URL base", () => {
  assert.equal(xtreamOrigin("http://h.xyz:80/qualquer/coisa"), "http://h.xyz");
  assert.throws(() => xtreamOrigin("http://u:p@h.xyz"));
});

test("probeAccount: conta ativa", async () => {
  const { srv, base } = await listen((req, res) => {
    const u = new URL(req.url, base0);
    assert.equal(u.pathname, "/player_api.php");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user_info: { auth: 1, status: "Active", exp_date: "1893456000", max_connections: "2", active_cons: "0" } }));
  });
  const base0 = base;
  forgetProbe();
  const r = await probeAccount({ baseUrl: base, username: "u", password: "p" });
  srv.close();
  assert.equal(r.ok, true);
  assert.equal(r.account.maxConnections, 2);
  assert.equal(r.account.expiresAt, "2030-01-01T00:00:00.000Z");
});

test("probeAccount: senha errada (auth 0) e conta expirada = invalid", async () => {
  for (const ui of [{ auth: 0 }, { auth: 1, status: "Expired" }]) {
    const { srv, base } = await listen((_req, res) => res.end(JSON.stringify({ user_info: ui })));
    forgetProbe();
    const r = await probeAccount({ baseUrl: base, username: "u", password: "p" });
    srv.close();
    assert.deepEqual([r.ok, r.reason], [false, "invalid"]);
  }
});

test("probeAccount: 404 intermitente é repetido e depois dá certo", async () => {
  let n = 0;
  const { srv, base } = await listen((_req, res) => {
    if (++n < 3) { res.statusCode = 404; return res.end("nope"); }
    res.end(JSON.stringify({ user_info: { auth: "1", status: "Active" } }));
  });
  forgetProbe();
  const r = await probeAccount({ baseUrl: base, username: "u", password: "p" });
  srv.close();
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

test("probeAccount: painel fora do ar = unreachable (não 'invalid')", async () => {
  forgetProbe();
  const r = await probeAccount({ baseUrl: "http://127.0.0.1:1", username: "u", password: "p" });
  assert.deepEqual([r.ok, r.reason], [false, "unreachable"]);
});

test("xtreamConfigFor: lista própria (URL get.php) vira conexão Xtream e valida a conta", async () => {
  const { encryptSecret } = await import("../../src/shared/crypto.js");
  const { xtreamConfigFor } = await import("../../src/modules/xtream/xtream.service.js");
  const { srv, base } = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    assert.equal(u.searchParams.get("username"), "991776");
    res.end(JSON.stringify({ user_info: { auth: 1, status: "Active", exp_date: "1893456000", max_connections: "1" } }));
  });
  forgetProbe();
  const act = { playlistUrlEnc: encryptSecret(`${base}/get.php?username=991776&password=abc&type=m3u_plus&output=m3u8`) };
  const cfg = await xtreamConfigFor(act);
  srv.close();
  assert.equal(cfg.baseUrl, base);
  assert.equal(cfg.username, "991776");
  assert.equal(cfg.password, "abc");
  assert.equal(cfg.userAgent, "Mozilla/5.0");
  assert.equal(cfg.account.status, "Active");
});

test("xtreamConfigFor: conta recusada pelo painel devolve 403 PROVIDER_ACCOUNT_INVALID", async () => {
  const { encryptSecret } = await import("../../src/shared/crypto.js");
  const { xtreamConfigFor } = await import("../../src/modules/xtream/xtream.service.js");
  const { srv, base } = await listen((_q, res) => res.end(JSON.stringify({ user_info: { auth: 0 } })));
  forgetProbe();
  const act = { playlistUrlEnc: encryptSecret(`${base}/playlist/u/p/m3u_plus`) };
  await assert.rejects(() => xtreamConfigFor(act), (e) => e.status === 403 && e.code === "PROVIDER_ACCOUNT_INVALID");
  srv.close();
});

test("xtreamConfigFor: lista que não é Xtream dá 422 NOT_XTREAM_LIST", async () => {
  const { encryptSecret } = await import("../../src/shared/crypto.js");
  const { xtreamConfigFor } = await import("../../src/modules/xtream/xtream.service.js");
  await assert.rejects(() => xtreamConfigFor({ playlistUrlEnc: encryptSecret("http://h.xyz/lista.m3u") }), (e) => e.status === 422 && e.code === "NOT_XTREAM_LIST");
});
