// Teste de navegador real (Chromium via Playwright) da página do QR. Não precisa de banco: o servidor é um stub.
// Uso: NODE_PATH=$(npm root -g) node tests/browser/pair-page.browser.mjs
import http from "node:http";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { pairPageHtml } from "../../src/modules/devices/pair-page.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const GOOD = "A".repeat(43);
const EXPIRED = "B".repeat(43);
const MAC = "AA:BB:CC:DD:EE:FF";
let resolveCalls = [];
let referers = [];

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/pair") {
    referers.push(req.headers.referer ?? null);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    return res.end(pairPageHtml({ panelUrl: "https://painel.exemplo.com" }));
  }
  if (req.method === "POST" && req.url === "/pair/resolve") {
    let body = ""; req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const { token } = JSON.parse(body); resolveCalls.push(token);
      res.writeHead(token === GOOD ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(token === GOOD ? { mac: MAC, expiresAt: "2099-01-01T00:00:00Z" } : { code: "PAIRING_NOT_FOUND" }));
    });
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => { try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FALHOU", name + " :: " + e.message.split("\n")[0]]); } };

async function open(hash, { clipboard = true, ctx } = {}) {
  const context = ctx ?? (await browser.newContext({ permissions: clipboard ? ["clipboard-read", "clipboard-write"] : [] }));
  const page = await context.newPage();
  const cspViolations = []; const errors = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/pair${hash}`);
  return { page, context, cspViolations, errors };
}

await check("mostra o MAC do servidor, em destaque, e habilita o botão", async () => {
  const { page, cspViolations, errors } = await open(`#${GOOD}`);
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "ready");
  assert.equal(await page.textContent("#mac"), MAC);
  assert.equal(await page.isEnabled("#copy"), true);
  assert.deepEqual(cspViolations, []); assert.deepEqual(errors, []);
});

await check("o MAC aparece ACIMA do botão e das instruções", async () => {
  const { page } = await open(`#${GOOD}`);
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "ready");
  const y = async (sel) => (await page.locator(sel).boundingBox()).y;
  assert.ok((await y("#mac")) < (await y("#copy")));
  assert.ok((await y("#copy")) < (await y(".steps")));
});

await check("Copiar MAC coloca o MAC na área de transferência e confirma", async () => {
  const { page } = await open(`#${GOOD}`);
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "ready");
  await page.click("#copy");
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("copiado"));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), MAC);
});

await check("sem Clipboard API (contexto inseguro/negado) usa o plano B ou orienta a copiar manualmente", async () => {
  const { page } = await open(`#${GOOD}`, { clipboard: false });
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "ready");
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); });
  await page.click("#copy");
  await page.waitForFunction(() => document.getElementById("status").textContent.length > 0);
  const msg = await page.textContent("#status");
  assert.ok(/copiado|selecionado/i.test(msg), msg);
});

await check("o token sai da barra de endereço e nunca vai na URL ao servidor", async () => {
  referers = [];
  const { page } = await open(`#${GOOD}`);
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "ready");
  assert.equal(new URL(page.url()).hash, "");
  assert.deepEqual(resolveCalls.at(-1), GOOD, "o token é enviado no corpo do POST");
});

await check("QR expirado/inexistente mostra erro claro e não habilita o botão", async () => {
  const { page } = await open(`#${EXPIRED}`);
  await page.waitForFunction(() => document.getElementById("mac").dataset.state === "error");
  assert.match(await page.textContent("#mac"), /inválido ou expirado/i);
  assert.equal(await page.isEnabled("#copy"), false);
});

await check("link sem token ou malformado não chama o servidor", async () => {
  const before = resolveCalls.length;
  for (const hash of ["", "#curto", "#" + "x".repeat(300), "#<script>alert(1)</script>"]) {
    const { page } = await open(hash);
    await page.waitForFunction(() => document.getElementById("mac").dataset.state === "error");
    assert.match(await page.textContent("#mac"), /Link inválido/);
  }
  assert.equal(resolveCalls.length, before);
});

await check("a página não tem formulário nem campo de entrada (nada a configurar)", async () => {
  const { page } = await open(`#${GOOD}`);
  assert.equal(await page.locator("form, input, select, textarea").count(), 0);
});

await check("atalho para o painel abre com rel seguro; some quando PANEL_URL não está definida", async () => {
  const { page } = await open(`#${GOOD}`);
  assert.equal(await page.getAttribute("#panel", "href"), "https://painel.exemplo.com");
  assert.match(await page.getAttribute("#panel", "rel"), /noopener/);
  assert.equal(pairPageHtml({}).includes('id="panel"'), false);
  assert.equal(pairPageHtml({ panelUrl: 'https://x.com/"><script>1</script>' }).includes("<script>1</script>"), false, "URL do painel é escapada");
});

await check("falha de rede mostra mensagem e não quebra", async () => {
  const { page, context } = await open(`#${GOOD}`, {});
  const p2 = await context.newPage();
  await p2.route("**/pair/resolve", (r) => r.abort());
  await p2.goto(`${base}/pair#${GOOD}`);
  await p2.waitForFunction(() => document.getElementById("mac").dataset.state === "error");
  assert.match(await p2.textContent("#mac"), /conexão/i);
});

await browser.close(); server.close();
let failed = 0;
for (const [s, n] of results) { console.log(`${s === "ok" ? "ok    " : "FALHOU"} ${n}`); if (s !== "ok") failed++; }
console.log(`\n${results.length - failed}/${results.length} passaram`);
process.exit(failed ? 1 : 0);
