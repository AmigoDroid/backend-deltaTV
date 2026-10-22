/**
 * Integração: recuperação por MAC (reinstalação) e acesso por chave de 6 dígitos (exige PostgreSQL).
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/iptv_licensing_test npm test
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";

const DB = process.env.DATABASE_URL_TEST;
const suite = DB ? describe : describe.skip;
const ADMIN = { email: "root@test.local", password: "senha-super-segura-123" };

suite("Recuperação por MAC e acesso por chave (integração)", () => {
  let base, server, M, sequelize, adminToken, plans, fake, providerBase;
  const cli = (...a) => execFileSync("npx", ["sequelize-cli", ...a], { env: { ...process.env, DATABASE_URL: DB, NODE_ENV: "test", ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password }, stdio: "pipe" });
  async function api(method, path, { token, body } = {}) {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* sem corpo */ }
    return { status: res.status, body: json, text };
  }
  let seq = 0;
  const mac = () => `DD:EE:FF:01:${String(Math.floor(++seq / 256)).padStart(2, "0")}:${(seq % 256).toString(16).padStart(2, "0").toUpperCase()}`;
  const install = (m) => `roku-${m.replaceAll(":", "")}`;
  const register = (m) => api("POST", "/api/v1/client/register", { body: { mac: m, installationId: install(m) } });
  const poll = (m, reg) => api("POST", "/api/v1/client/register/status", { body: { mac: m, installationId: install(m), registrationToken: reg.body.pairing.registrationToken } });
  const liveSessions = (activationId) => M.DeviceSession.count({ where: { activationId, revokedAt: null, expiresAt: { [M.Op.gt]: new Date() } } });

  /** TV ativada por licença, com lista própria. Devolve token, MAC, ids. */
  async function activatedTv() {
    const lic = await api("POST", "/api/v1/admin/licenses", { token: adminToken, body: { planId: plans[0].id, customer: { name: "Cliente Recuperação" } } });
    assert.equal(lic.status, 201, lic.text);
    const m = mac();
    const act = await api("POST", "/api/v1/client/activate/license", { body: { code: lic.body.code, mac: m } });
    assert.equal(act.status, 201, act.text);
    const cfg = await api("POST", "/api/v1/client/configure/playlist", { token: act.body.tokens.accessToken, body: { name: "Lista Secreta do Cliente", url: `${providerBase}/list.m3u` } });
    assert.equal(cfg.status, 200, cfg.text);
    return { mac: m, token: act.body.tokens.accessToken, activationId: act.body.activationId, licenseId: lic.body.license.id };
  }

  before(async () => {
    process.env.DATABASE_URL = DB; process.env.NODE_ENV = "test"; process.env.RATE_LIMIT_DISABLED = "true"; process.env.ALLOW_PRIVATE_SOURCES = "true";
    fake = http.createServer((req, res) => {
      if (req.url.startsWith("/list.m3u")) { res.setHeader("content-type", "audio/x-mpegurl"); return res.end('#EXTM3U\n#EXTINF:-1 group-title="G",Canal\nhttp://127.0.0.1:1/live/u/p/1.ts\n'); }
      res.statusCode = 404; res.end();
    }).listen(0);
    providerBase = `http://127.0.0.1:${fake.address().port}`;
    cli("db:migrate:undo:all"); cli("db:migrate"); cli("db:seed:all");
    ({ sequelize, ...M } = await import("../../src/db/models/index.js"));
    M.Op = (await import("sequelize")).Op;
    const { createApp } = await import("../../src/app.js");
    server = createApp().listen(0); base = `http://127.0.0.1:${server.address().port}`;
    const login = await api("POST", "/api/v1/auth/login", { body: ADMIN });
    adminToken = login.body.accessToken;
    plans = (await api("GET", "/api/v1/admin/licenses/plans", { token: adminToken })).body.data;
  });
  after(async () => { server?.close(); fake?.close(); await sequelize?.close(); delete process.env.DEVICE_RECOVERY_MODE; });

  /* ---------------- recuperação por MAC ---------------- */
  test("reinstalação: o MAC reconhece a TV e ela volta sem refazer a configuração, sem vazar a lista", async () => {
    const tv = await activatedTv();
    const reg = await register(tv.mac);
    assert.equal(reg.status, 200, reg.text);
    assert.equal(reg.body.status, "awaiting_configuration");
    assert.equal(reg.body.configured, false);
    assert.ok(reg.body.pairing.registrationToken);
    assert.equal(/Lista Secreta|activationId|listName|"mode"/.test(reg.text), false, "quem só conhece o MAC não vê a lista nem o estado");

    const done = await poll(tv.mac, reg);
    assert.equal(done.status, 200, done.text);
    assert.equal(done.body.allowed, true);
    assert.ok(done.body.tokens.accessToken && done.body.tokens.refreshToken);
    assert.equal((await api("GET", "/api/v1/client/resources", { token: done.body.tokens.accessToken })).status, 200, "a sessão nova funciona");

    const dev = await M.Device.findOne({ where: { mac: tv.mac } });
    assert.ok(dev.installationChangedAt, "troca de instalação registrada");
    assert.ok(await M.AuditLog.findOne({ where: { action: "device.recovered", entityId: String(dev.id) } }));
    assert.equal((await poll(tv.mac, reg)).status, 409, "o registro de recuperação é de uso único");
  });

  test("teto de sessões: recuperar várias vezes não acumula sessões e derruba só as mais antigas", async () => {
    const tv = await activatedTv();
    let last;
    for (let i = 0; i < 5; i++) { const reg = await register(tv.mac); last = await poll(tv.mac, reg); assert.equal(last.status, 200, last.text); }
    assert.ok((await liveSessions(tv.activationId)) <= 3, "no máximo 3 sessões vivas (MAX_SESSIONS_PER_ACTIVATION)");
    assert.equal((await api("GET", "/api/v1/client/resources", { token: tv.token })).status, 401, "a sessão mais antiga foi revogada");
    assert.equal((await api("GET", "/api/v1/client/resources", { token: last.body.tokens.accessToken })).status, 200);
  });

  test("proof_required: o MAC sozinho não recupera (comportamento exigindo QR/chave)", async () => {
    const tv = await activatedTv();
    process.env.DEVICE_RECOVERY_MODE = "proof_required";
    try {
      const reg = await register(tv.mac);
      assert.equal(reg.body.status, "session_required");
      assert.equal(reg.body.pairing, null);
    } finally { delete process.env.DEVICE_RECOVERY_MODE; }
  });

  test("licença bloqueada: a recuperação não entrega sessão", async () => {
    const tv = await activatedTv();
    const blocked = await api("POST", `/api/v1/admin/licenses/${tv.licenseId}/block`, { token: adminToken, body: { reason: "bloqueio de teste da recuperação" } });
    assert.ok([200, 204].includes(blocked.status), blocked.text);
    const reg = await register(tv.mac);
    assert.equal(reg.status, 200);
    const done = await poll(tv.mac, reg);
    assert.equal(done.body.tokens, undefined, "sem tokens");
    assert.notEqual(done.body.allowed, true);
  });

  test("MAC novo (sem ativação) continua no fluxo de QR normal", async () => {
    const reg = await register(mac());
    assert.equal(reg.body.status, "awaiting_configuration");
    assert.match(reg.body.pairing.url, /\/pair#/);
  });

  /* ---------------- acesso por chave de 6 dígitos ---------------- */
  const issue = (tv) => api("POST", "/api/v1/client/device-key", { token: tv.token });
  const login = (m, key) => api("POST", "/api/v1/device-access/login", { body: { mac: m, key } });

  test("a chave só sai para uma TV com sessão; MAC desconhecido e chave errada recebem a MESMA resposta", async () => {
    const tv = await activatedTv();
    assert.equal((await api("POST", "/api/v1/client/device-key")).status, 401, "sem sessão não há chave");
    const k = await issue(tv);
    assert.equal(k.status, 200, k.text);
    assert.match(k.body.key, /^\d{6}$/);
    const wrongKey = k.body.key === "000000" ? "000001" : "000000";
    const a = await login(tv.mac, wrongKey);
    const b = await login("DE:AD:BE:EF:00:09", "123456");
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.deepEqual(a.body, b.body, "não revela se o MAC existe");
    assert.equal((await login("ZZ", "123456")).status, 400);
    assert.equal((await login(tv.mac, "12345")).status, 400);
  });

  test("5 erros invalidam a chave (a certa deixa de valer) e só uma nova, gerada na TV, volta a funcionar", async () => {
    const tv = await activatedTv();
    const k = await issue(tv);
    const wrong = k.body.key === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await login(tv.mac, wrong)).status, 401);
    assert.equal((await login(tv.mac, k.body.key)).status, 401, "invalidada");
    const k2 = await issue(tv);
    assert.equal((await login(tv.mac, k2.body.key)).status, 200);
  });

  test("login por chave: sessão limitada ao dispositivo; edita só a própria lista; uso único; auditoria de quem fez", async () => {
    const tv = await activatedTv();
    const other = await activatedTv();
    const k = await issue(tv);
    const ok = await login(tv.mac.toLowerCase().replaceAll(":", "-"), k.body.key);
    assert.equal(ok.status, 200, ok.text);
    const token = ok.body.token;
    assert.ok(new Date(ok.body.expiresAt) > new Date());
    assert.equal((await login(tv.mac, k.body.key)).status, 401, "a chave é de uso único");

    const me = await api("GET", "/api/v1/device-access/me", { token });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.mac, tv.mac);

    const cfg = await api("POST", "/api/v1/device-access/configure", { token, body: { mode: "playlist", confirm: true, name: "Nova lista", url: `${providerBase}/list.m3u?v=2` } });
    assert.equal(cfg.status, 200, cfg.text);
    const dev = await M.Device.findOne({ where: { mac: tv.mac } });
    const row = await M.AuditLog.findOne({ where: { action: "device.configuration.confirm", entityId: String(dev.id) }, order: [["createdAt", "DESC"]] });
    assert.equal(row.actorType, "device_key");
    assert.equal(row.metadata.actorName, "Acesso por chave da TV");

    // escopo: nada além deste dispositivo
    for (const path of ["/api/v1/admin/devices/registrations", "/api/v1/admin/licenses", "/api/v1/partner/me", "/api/v1/client/resources"]) {
      assert.ok([401, 403].includes((await api("GET", path, { token })).status), `${path} deve negar a sessão de dispositivo`);
    }
    assert.equal((await api("GET", "/api/v1/device-access/me", { token: adminToken })).status, 401, "token de admin não vale aqui");
    const otherState = await api("GET", "/api/v1/device-access/me", { token });
    assert.equal(otherState.body.mac, tv.mac);
    assert.notEqual(otherState.body.mac, other.mac);

    const removed = await api("POST", "/api/v1/device-access/remove-list", { token, body: { reason: "cliente pediu" } });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.removed, true);
    assert.equal((await M.License.findByPk(tv.licenseId)).status, "active", "remover a lista não mexe na licença");

    assert.equal((await api("POST", "/api/v1/device-access/logout", { token })).status, 204);
    assert.equal((await api("GET", "/api/v1/device-access/me", { token })).status, 401);
  });

  test("sessão por chave expira e uma nova chave invalida a anterior", async () => {
    const tv = await activatedTv();
    const k1 = await issue(tv);
    const k2 = await issue(tv);
    assert.equal((await login(tv.mac, k1.body.key)).status, 401, "a chave anterior deixou de valer");
    const ok = await login(tv.mac, k2.body.key);
    assert.equal(ok.status, 200);
    await M.DeviceScopedSession.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { deviceId: (await M.Device.findOne({ where: { mac: tv.mac } })).id } });
    assert.equal((await api("GET", "/api/v1/device-access/me", { token: ok.body.token })).status, 401);
  });
});
