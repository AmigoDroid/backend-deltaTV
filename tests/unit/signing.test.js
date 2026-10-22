import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signOriginUrl } from "../../src/modules/sources/signing.js";

test("sem assinatura devolve a URL original", () => {
  assert.equal(signOriginUrl("http://o.example/a.ts", { type: "none" }, "s"), "http://o.example/a.ts");
});
test("hmac-query: expira em ttl e assina caminho+expiração", () => {
  const u = new URL(signOriginUrl("http://o.example/live/1.ts", { type: "hmac-query", ttlSeconds: 30 }, "segredo", 1000));
  assert.equal(u.searchParams.get("expires"), "1030");
  const expected = crypto.createHmac("sha256", "segredo").update("/live/1.ts1030").digest("hex");
  assert.equal(u.searchParams.get("token"), expected);
});
test("nginx-secure-link segue a fórmula do módulo secure_link", () => {
  const u = new URL(signOriginUrl("http://o.example/v/a.mp4", { type: "nginx-secure-link", ttlSeconds: 60 }, "k", 2000));
  const expected = crypto.createHash("md5").update("2060/v/a.mp4 k").digest("base64url");
  assert.equal(u.searchParams.get("md5"), expected);
  assert.equal(u.searchParams.get("expires"), "2060");
});
test("tipo desconhecido falha explicitamente", () => {
  assert.throws(() => signOriginUrl("http://o.example/x", { type: "xyz" }, "s"));
});
