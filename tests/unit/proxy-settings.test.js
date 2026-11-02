import test from "node:test";
import assert from "node:assert/strict";
import { resolveBindHost, resolveTrustProxy, proxyConfigurationWarnings } from "../../src/shared/proxy-config.js";

test("produção local confia somente no Nginx loopback por padrão", () => {
  const host = resolveBindHost("production", undefined);
  assert.equal(host, "127.0.0.1");
  assert.equal(resolveTrustProxy(undefined, { isProd: true, bindHost: host }), "loopback");
});

test("API exposta ou ambiente de desenvolvimento não confiam em X-Forwarded-For por padrão", () => {
  assert.equal(resolveTrustProxy(undefined, { isProd: true, bindHost: "0.0.0.0" }), 0);
  assert.equal(resolveTrustProxy(undefined, { isProd: false, bindHost: "127.0.0.1" }), 0);
});

test("configuração explícita preservada e validada", () => {
  assert.equal(resolveTrustProxy("0", { isProd: true, bindHost: "127.0.0.1" }), 0);
  assert.equal(resolveTrustProxy("loopback", { isProd: true, bindHost: "127.0.0.1" }), "loopback");
  assert.equal(resolveTrustProxy("false", { isProd: true, bindHost: "127.0.0.1" }), 0);
  assert.throws(() => resolveTrustProxy("qualquer coisa", { isProd: true, bindHost: "127.0.0.1" }), /TRUST_PROXY inválido/);
});

test("configuração que registraria loopback em vez de IP real gera aviso", () => {
  const messages = proxyConfigurationWarnings({ isProd: true, bindHost: "127.0.0.1", trustProxy: 0 });
  assert.match(messages.join(" "), /127\.0\.0\.1/);
});
