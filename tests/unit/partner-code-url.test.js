import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShortCode, shortCodeProblem, randomNumericCode } from "../../src/modules/partners/short-code.js";
import { buildPlaylistUrl, normalizeBaseUrl, validateTemplate, DEFAULT_TEMPLATE } from "../../src/modules/providers/playlist-url.js";

test("código curto: normaliza e valida formato", () => {
  assert.equal(normalizeShortCode("  ab12 "), "AB12");
  assert.equal(shortCodeProblem("4343"), null);
  assert.equal(shortCodeProblem("ABC123XYZ789"), null);
  assert.ok(shortCodeProblem("123"), "menos de 4");
  assert.ok(shortCodeProblem("1234567890123"), "mais de 12");
  assert.ok(shortCodeProblem("12 34"), "espaço");
  assert.ok(shortCodeProblem("12-34"), "símbolo");
  assert.ok(shortCodeProblem("OLD1234"), "prefixo reservado");
});
test("código numérico gerado tem o tamanho pedido", () => {
  for (const n of [4, 5, 8]) assert.match(randomNumericCode(n), new RegExp(`^\\d{${n}}$`));
});
test("URL da playlist segue o padrão Xtream com type e output corretos", () => {
  const url = buildPlaylistUrl("http://valkiire.net", DEFAULT_TEMPLATE, { username: "joao", password: "abc123" });
  assert.equal(url, "http://valkiire.net/get.php?username=joao&password=abc123&type=m3u_plus&output=m3u8");
});
test("aceita os apelidos {usuario} e {senha}", () => {
  const url = buildPlaylistUrl("http://h.net:8080", "/get.php?username={usuario}&password={senha}", { username: "a", password: "b" });
  assert.equal(url, "http://h.net:8080/get.php?username=a&password=b");
});
test("caracteres especiais na senha são codificados e não quebram a URL", () => {
  const url = buildPlaylistUrl("http://h.net", DEFAULT_TEMPLATE, { username: "a&b", password: "p@ss/w#rd&type=x" });
  const u = new URL(url);
  assert.equal(u.searchParams.get("username"), "a&b");
  assert.equal(u.searchParams.get("password"), "p@ss/w#rd&type=x");
  assert.equal(u.searchParams.get("type"), "m3u_plus", "a senha não pode injetar parâmetros");
  assert.equal(u.host, "h.net");
});
test("template que desvia de host é rejeitado", () => {
  assert.throws(() => validateTemplate("//evil.com/get.php?u={username}&p={password}"), /desvia/);
  assert.throws(() => buildPlaylistUrl("http://h.net", "http://evil.com/x?u={username}&p={password}", { username: "a", password: "b" }), /desvia/);
});
test("template precisa de usuário e senha, começar com / e não ter espaços", () => {
  assert.throws(() => validateTemplate("/get.php?u={username}"), /conter/);
  assert.throws(() => validateTemplate("get.php?u={username}&p={password}"), /começar/);
  assert.throws(() => validateTemplate("/get.php?u={username} &p={password}"), /espa/i);
  assert.doesNotThrow(() => validateTemplate(DEFAULT_TEMPLATE));
});
test("URL base: só origem, sem credenciais embutidas", () => {
  assert.equal(normalizeBaseUrl("http://valkiire.net/qualquer/caminho?x=1"), "http://valkiire.net");
  assert.equal(normalizeBaseUrl("https://srv.com:8443/"), "https://srv.com:8443");
  assert.throws(() => normalizeBaseUrl("http://user:pass@valkiire.net"), /usuário/);
  assert.throws(() => normalizeBaseUrl("ftp://valkiire.net"), /HTTP/);
});
