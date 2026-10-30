import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeModes, parseModesEnv, webDefaultModes, resolveModes, needsMirror, WEB_DEFAULT_MODES } from "../../src/modules/web/web-modes.js";

test("padrão do web: só a live via proxy; catálogo, filmes e séries via redirect", () => {
  assert.deepEqual({ ...WEB_DEFAULT_MODES }, { api: "redirect", live: "proxy", movie: "redirect", series: "redirect" });
});

test("sanitizeModes descarta chaves e valores desconhecidos", () => {
  assert.deepEqual(sanitizeModes({ live: "redirect", movie: "x", foo: "proxy" }), { live: "redirect" });
  assert.deepEqual(sanitizeModes(null), {});
  assert.deepEqual(sanitizeModes([]), {});
});

test("ambiente sobrescreve os padrões, ignorando lixo", () => {
  assert.deepEqual(parseModesEnv("movie=proxy, live=zzz ,x=proxy"), { movie: "proxy" });
  assert.equal(webDefaultModes("movie=proxy").movie, "proxy");
  assert.equal(webDefaultModes("").movie, "redirect");
});

test("override por tipo > modo único forçado > automático", () => {
  assert.deepEqual(resolveModes({ deliveryModes: { live: "proxy" }, forced: "redirect", fallback: "proxy" }),
    { api: "redirect", live: "proxy", movie: "redirect", series: "redirect" });
  assert.deepEqual(resolveModes({ deliveryModes: null, forced: null, fallback: "redirect" }),
    { api: "redirect", live: "redirect", movie: "redirect", series: "redirect" });
});

test("espelho só é necessário se algum tipo for proxy", () => {
  assert.equal(needsMirror({ api: "redirect", live: "redirect", movie: "redirect", series: "redirect" }), false);
  assert.equal(needsMirror({ api: "redirect", live: "redirect", movie: "proxy", series: "redirect" }), true);
});
