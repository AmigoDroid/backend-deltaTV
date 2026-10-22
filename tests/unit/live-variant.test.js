import test from "node:test";
import assert from "node:assert/strict";
import { liveVariantOrigin } from "../../src/modules/sources/live-variant.js";
import { signJwt, verifyJwt } from "../../src/shared/crypto.js";

test("canal Xtream .ts ganha a variante HLS (.m3u8) e vice-versa", () => {
  assert.equal(liveVariantOrigin("http://h:8080/live/u/p/123.ts", "m3u8"), "http://h:8080/live/u/p/123.m3u8");
  assert.equal(liveVariantOrigin("http://h:8080/live/u/p/123.m3u8", "ts"), "http://h:8080/live/u/p/123.ts");
  assert.equal(liveVariantOrigin("http://h:8080/live/u/p/123", "m3u8"), "http://h:8080/live/u/p/123.m3u8");
  assert.equal(liveVariantOrigin("http://h:8080/live/u/p/123", "ts"), "http://h:8080/live/u/p/123.ts");
});

test("formato clássico /usuario/senha/<id numérico> também é convertido", () => {
  assert.equal(liveVariantOrigin("http://h/u/p/456", "m3u8"), "http://h/u/p/456.m3u8");
  assert.equal(liveVariantOrigin("http://h/u/p/456.ts", "m3u8"), "http://h/u/p/456.m3u8");
});

test("preserva query e host/porta", () => {
  assert.equal(liveVariantOrigin("http://h:80/live/u/p/9.ts?x=1", "m3u8"), "http://h/live/u/p/9.m3u8?x=1");
});

test("origens que não são Xtream, extensões desconhecidas e entradas inválidas ficam intactas", () => {
  for (const [u, w] of [
    ["http://cdn.example/canal/globo/index.ts", "m3u8"],
    ["http://cdn.example/live/stream.name.ts", "m3u8"],
    ["http://cdn.example/hls/abc/playlist.m3u8", "ts"],
    ["http://h/live/u/p/1.ts", ""],
    ["http://h/live/u/p/1.ts", "mp4"],
    ["isso nao e url", "m3u8"],
  ]) assert.equal(liveVariantOrigin(u, w), u);
});

test("token de reprodução vencido só é aceito com tolerância (HLS ao vivo)", () => {
  const t = signJwt({ typ: "play", sid: "s", aid: "a" }, -60); // venceu há 60 s
  assert.throws(() => verifyJwt(t, "play"), { code: "INVALID_TOKEN" });
  assert.equal(verifyJwt(t, "play", { graceSeconds: 3600 }).sid, "s");
  const old = signJwt({ typ: "play", sid: "s", aid: "a" }, -7200); // venceu há 2 h
  assert.throws(() => verifyJwt(old, "play", { graceSeconds: 3600 }), { code: "INVALID_TOKEN" });
  assert.throws(() => verifyJwt(t, "device", { graceSeconds: 3600 }), { code: "INVALID_TOKEN" }); // tipo errado continua negado
});
