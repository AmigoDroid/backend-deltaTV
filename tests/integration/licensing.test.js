/**
 * Testes de integração (exigem PostgreSQL). Execute com:
 *   createdb iptv_licensing_test
 *   DATABASE_URL_TEST=postgres://postgres:postgres@localhost:5432/iptv_licensing_test npm test
 * ATENÇÃO: o banco informado é DESTRUÍDO e recriado (db:migrate:undo:all). Nunca aponte para produção.
 * Sem DATABASE_URL_TEST os testes são ignorados (skip).
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { safeGet } from "../../src/shared/ssrf.js";

const DB = process.env.DATABASE_URL_TEST;
const suite = DB ? describe : describe.skip;
const ADMIN = { email: "root@test.local", password: "senha-super-segura-123" };

suite("Licenciamento IPTV (integração)", () => {
  let base, server, M, sequelize, adminToken, plans, fake, providerBase;
  const cli = (...args) =>
    execFileSync("npx", ["sequelize-cli", ...args], {
      env: { ...process.env, DATABASE_URL: DB, NODE_ENV: "test", ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password },
      stdio: "pipe",
    });

  async function api(method, path, { token, body, headers = {}, raw = false, redirect } = {}) {
    const res = await fetch(base + path, {
      method, redirect,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* sem corpo */ }
    return { status: res.status, body: json, headers: res.headers };
  }

  let macSeq = 0;
  const mac = () => `AA:BB:CC:00:${String(Math.floor(++macSeq / 256)).padStart(2, "0")}:${(macSeq % 256).toString(16).padStart(2, "0").toUpperCase()}`;

  const newLicense = async (over = {}) => {
    const r = await api("POST", "/api/v1/admin/licenses", { token: adminToken, body: { planId: plans[0].id, customer: { name: "Cliente Teste" }, ...over } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return { id: r.body.license.id, code: r.body.code };
  };
  const activateLicense = (code, m = mac(), extra = {}) =>
    api("POST", "/api/v1/client/activate/license", { body: { code, mac: m, ...extra } });
  // Parceria: código curto + usuário/senha do provedor (o servidor falso aceita u1 / p1).
  const activatePartner = (code, m = mac(), extra = {}) =>
    api("POST", "/api/v1/client/activate/partner", { body: { code, mac: m, username: "u1", password: "p1", ...extra } });
  const register = (m = mac()) =>
    api("POST", "/api/v1/client/register", { body: { mac: m, installationId: `roku-${m.replaceAll(":", "")}` } });
  const pairingToken = (r) => new URL(r.body.pairing.url).hash.slice(1);
  const resources = (r) => api("GET", "/api/v1/client/resources", { token: r.body.tokens.accessToken });

  async function newPartner(over = {}) {
    const slug = `p-${crypto.randomBytes(4).toString("hex")}`;
    const email = `${slug}@test.local`;
    const r = await api("POST", "/api/v1/admin/partners", {
      token: adminToken,
      body: {
        name: `Parceiro ${slug}`, slug, billingModel: "fixed", monthlyFeeCents: 10000, graceDays: 5,
        startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        portalUser: { name: "Dono", email, password: "senha-do-parceiro-123" }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== "providerBase")),
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const prov = await api("POST", `/api/v1/admin/partners/${r.body.id}/providers`, { token: adminToken, body: { name: "Servidor", baseUrl: over.providerBase ?? providerBase, deliveryMode: "redirect" } });
    assert.equal(prov.status, 201, JSON.stringify(prov.body));
    const codeRes = await api("POST", `/api/v1/admin/partners/${r.body.id}/codes`, { token: adminToken, body: { label: "principal" } });
    assert.equal(codeRes.status, 201, JSON.stringify(codeRes.body));
    const code = codeRes.body.code;
    const login = await api("POST", "/api/v1/auth/login", { body: { email, password: "senha-do-parceiro-123" } });
    return { id: r.body.id, code, email, token: login.body.accessToken };
  }

  async function newPartnerNoProvider() {
    const slug = `n-${crypto.randomBytes(4).toString("hex")}`;
    const r = await api("POST", "/api/v1/admin/partners", { token: adminToken, body: { name: slug, slug, billingModel: "fixed", monthlyFeeCents: 100, startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 86400000 * 30).toISOString() } });
    return r.body;
  }

  before(async () => {
    process.env.DATABASE_URL = DB;
    process.env.NODE_ENV = "test";
    process.env.RATE_LIMIT_DISABLED = "true";
    process.env.ALLOW_PRIVATE_SOURCES = "true"; // o provedor falso roda em 127.0.0.1 (o teste de SSRF desliga isto)
    fake = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/get.php") {
        const ok = u.searchParams.get("username") === "u1" && u.searchParams.get("password") === "p1"
          && u.searchParams.get("type") === "m3u_plus" && u.searchParams.get("output") === "m3u8";
        if (!ok) return res.end('{"user_info":{"auth":0}}'); // Xtream responde 200 com corpo vazio/JSON quando recusa
        res.setHeader("content-type", "audio/x-mpegurl");
        return res.end(`#EXTM3U\n#EXTINF:-1 tvg-id="c1" tvg-logo="" group-title="Canais",Canal Um\nhttp://127.0.0.1:${fake.address().port}/live/u1/p1/1.ts\n`);
      }
      if (u.pathname === "/external.m3u") {
        res.setHeader("content-type", "audio/x-mpegurl");
        return res.end(`#EXTM3U\n#EXTINF:-1 group-title="Canais",Canal Externo\nhttp://127.0.0.1:${fake.address().port}/live/u1/p1/1.ts\n`);
      }
      if (u.pathname === "/ssrf-redirect") {
        process.env.ALLOW_PRIVATE_SOURCES = "false";
        res.statusCode = 302;
        res.setHeader("location", `http://127.0.0.1:${fake.address().port}/live/u1/p1/1.ts`);
        return res.end();
      }
      if (u.pathname.startsWith("/live/")) { res.setHeader("content-type", "video/mp2t"); return res.end("TSDATA"); }
      res.statusCode = 404; res.end();
    }).listen(0);
    providerBase = `http://127.0.0.1:${fake.address().port}`;
    cli("db:migrate:undo:all");
    cli("db:migrate");
    cli("db:seed:all");
    ({ sequelize, ...M } = await import("../../src/db/models/index.js"));
    const { createApp } = await import("../../src/app.js");
    server = createApp().listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    const login = await api("POST", "/api/v1/auth/login", { body: ADMIN });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    adminToken = login.body.accessToken;
    plans = (await api("GET", "/api/v1/admin/licenses/plans", { token: adminToken })).body.data;
  });
  after(async () => {
    server?.close();
    fake?.close();
    await sequelize?.close();
  });

  test("16. migrations funcionam em instalação limpa e são reversíveis", async () => {
    const [rows] = await sequelize.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('licenses','partners','activations','invoices','audit_logs','device_sessions','device_pairing_tokens')`);
    assert.equal(rows[0].n, 7);
    assert.equal(plans.length, 3);
    assert.deepEqual(plans.map((p) => p.durationMonths).sort((a, b) => a - b), [4, 6, 12]);
  });

  test("1. ativação válida de licença individual", async () => {
    const { code } = await newLicense();
    const r = await activateLicense(code);
    assert.equal(r.status, 201);
    assert.equal(r.body.kind, "license");
    assert.equal((await resources(r)).status, 200);
  });

  test("registro Roku idempotente valida MAC/installationId e cria QR temporário", async () => {
    const m = mac();
    const first = await register(m);
    const second = await register(m);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.deviceId, second.body.deviceId);
    assert.equal(first.body.installationId, `roku-${m.replaceAll(":", "")}`);
    assert.match(first.body.pairing.url, /\/pair#/);
    assert.equal(pairingToken(first), pairingToken(second), "repetir registro devolve o mesmo pareamento pendente");
    assert.equal(await M.Device.count({ where: { mac: m } }), 1);
    const malformed = await api("POST", "/api/v1/client/register", {
      body: { mac: m, installationId: "roku-aabbccddeeff" },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, "VALIDATION_ERROR");
    const mismatch = await api("POST", "/api/v1/client/register", {
      body: { mac: m, installationId: "roku-112233445566" },
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.code, "INSTALLATION_ID_MISMATCH");
    const pairingRow = await M.DevicePairingToken.findOne({ where: { tokenHash: crypto.createHash("sha256").update(pairingToken(first)).digest("hex") } });
    await pairingRow.update({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await api("POST", "/pair/resolve", { body: { token: pairingToken(first) } });
    assert.equal(expired.status, 404);
    assert.equal(expired.body.code, "PAIRING_NOT_FOUND");
    const replacement = await register(m);
    assert.notEqual(pairingToken(replacement), pairingToken(first), "QR expirado é substituído por um novo");
    assert.equal((await api("POST", "/pair/resolve", { body: { token: pairingToken(replacement) } })).status, 200);
  });

  test("QR só revela o MAC (servidor decide o MAC) e não configura nada; a rota pública antiga não existe", async () => {
    const registration = await register();
    const token = pairingToken(registration);
    const page = await api("GET", "/pair");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await (await fetch(base + "/pair")).text();
    assert.ok(html.includes("Copiar MAC"));
    assert.equal(/<form|<input|<select|<textarea/i.test(html), false, "a página não tem campos nem formulário");
    const resolved = await api("POST", "/pair/resolve", { body: { token } });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.mac, registration.body.mac);
    assert.equal(JSON.stringify(resolved.body).includes("registrationToken"), false);
    assert.equal((await api("POST", "/pair/resolve", { body: { token } })).status, 200, "resolver não consome o QR");
    const unknown = await api("POST", "/pair/resolve", { body: { token: crypto.randomBytes(32).toString("base64url") } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "PAIRING_NOT_FOUND");
    assert.equal((await api("POST", "/pair/resolve", { body: { token: "curto" } })).status, 400);
    const old = await api("POST", "/api/v1/client/pairing/configure", { body: { mode: "partner", token, code: "X", username: "u", password: "p" } });
    assert.equal(old.status, 404, "configuração pública por token foi removida");
    const status = await api("POST", "/api/v1/client/register/status", {
      body: { mac: registration.body.mac, installationId: registration.body.installationId, registrationToken: registration.body.pairing.registrationToken },
    });
    assert.notEqual(status.body.status, "configured_partner", "nada foi configurado só por abrir o QR");
  });

  // ---- Revendedor edita a TV pelo MAC; auditoria diz QUEM alterou ----
  const mkReseller = (over = {}) => newPartner({ kind: "reseller", ...over });
  const lookup = (r, m) => api("POST", "/api/v1/partner/mac/lookup", { token: r.token, body: { mac: m } });
  const configureAs = (r, m, configuration) => api("POST", "/api/v1/partner/mac/configure", { token: r.token, body: { mac: m, configuration } });

  test("revendedor configura a TV só com o MAC; a TV recebe a sessão e a auditoria registra pessoa e revendedor", async () => {
    const content = await newPartner();
    const rs = await mkReseller();
    const registration = await register();
    const m = registration.body.mac;

    const before = await lookup(rs, m);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.configured, false);

    const configured = await configureAs(rs, m, { mode: "partner", confirm: true, code: content.code, username: "u1", password: "p1" });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.configured, true);
    assert.equal(JSON.stringify(configured.body).includes("p1"), false);

    const poll = await api("POST", "/api/v1/client/register/status", {
      body: { mac: m, installationId: registration.body.installationId, registrationToken: registration.body.pairing.registrationToken },
    });
    assert.equal(poll.status, 200);
    assert.equal(poll.body.status, "configured_partner");
    assert.ok(poll.body.tokens.accessToken && poll.body.tokens.refreshToken, "a TV conclui sem reiniciar");

    const partnerRow = await M.Partner.findByPk(rs.id);
    const user = await M.AdminUser.findOne({ where: { email: rs.email } });
    const row = await M.AuditLog.findOne({ where: { action: "device.configuration.confirm", entityId: String(registration.body.deviceId) } });
    assert.ok(row, "a alteração foi auditada");
    assert.equal(row.actorId, String(user.id));
    assert.equal(row.metadata.actorName, "Dono");
    assert.equal(row.metadata.actorPartnerId, rs.id);
    assert.equal(row.metadata.actorPartnerName, partnerRow.name);
    assert.equal(JSON.stringify(row.metadata).includes("p1"), false, "senha do provedor não vai para a auditoria");

    const history = await api("POST", "/api/v1/partner/mac/history", { token: rs.token, body: { mac: m } });
    assert.equal(history.status, 200);
    const ev = history.body.events.find((e) => e.action === "device.configuration.confirm");
    assert.equal(ev.actorName, "Dono");
    assert.equal(ev.actorPartnerName, partnerRow.name);
  });

  test("qualquer revendedor ativo edita o MAC de outro (política padrão) e o histórico mostra quem fez cada troca", async () => {
    const c1 = await newPartner();
    const c2 = await newPartner();
    const rs1 = await mkReseller();
    const rs2 = await mkReseller();
    const registration = await register();
    const m = registration.body.mac;
    assert.equal((await configureAs(rs1, m, { mode: "partner", confirm: true, code: c1.code, username: "u1", password: "p1" })).status, 200);
    const swapped = await configureAs(rs2, m, { mode: "partner", confirm: true, code: c2.code, username: "u1", password: "p1" });
    assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
    const names = (await api("POST", "/api/v1/partner/mac/history", { token: rs1.token, body: { mac: m } })).body.events
      .filter((e) => e.action === "device.configuration.confirm").map((e) => e.actorPartnerName);
    assert.equal(new Set(names).size, 2, "as duas alterações aparecem, cada uma com seu revendedor");
    const last = (await lookup(rs1, m)).body.lastChange;
    assert.equal(last.actorPartnerName, (await M.Partner.findByPk(rs2.id)).name, "a última alteração é de rs2");
  });

  test("owner_only: revendedor não altera TV configurada por outro; o autor da configuração continua podendo", async () => {
    const c = await newPartner();
    const rsA = await mkReseller();
    const rsB = await mkReseller();
    const registration = await register();
    const m = registration.body.mac;
    assert.equal((await configureAs(rsA, m, { mode: "partner", confirm: true, code: c.code, username: "u1", password: "p1" })).status, 200);
    process.env.DEVICE_EDIT_POLICY = "owner_only";
    try {
      const denied = await configureAs(rsB, m, { mode: "partner", confirm: true, code: c.code, username: "u1", password: "p1" });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.code, "DEVICE_OWNED_BY_OTHER");
      assert.ok(await M.AuditLog.findOne({ where: { action: "device.edit.denied", entityId: String(registration.body.deviceId), result: "denied" } }), "a tentativa negada também é auditada");
      assert.equal((await lookup(rsA, m)).status, 200);
    } finally {
      delete process.env.DEVICE_EDIT_POLICY;
    }
    assert.equal((await lookup(rsB, m)).status, 200, "no padrão volta a valer qualquer revendedor");
  });

  test("não-revendedor, revendedor suspenso, sem login, MAC inválido e MAC desconhecido são recusados", async () => {
    const content = await newPartner(); // parceria de conteúdo (kind padrão)
    const rs = await mkReseller();
    const m = (await register()).body.mac;
    const nonReseller = await lookup(content, m);
    assert.equal(nonReseller.status, 403);
    assert.equal(nonReseller.body.code, "NOT_A_RESELLER");
    assert.equal((await api("POST", "/api/v1/partner/mac/lookup", { body: { mac: m } })).status, 401);
    const bad = await lookup(rs, "ZZ");
    assert.equal(bad.status, 400);
    const bad2 = await lookup(rs, "AA:BB:CC:DD:EE:GG");
    assert.equal(bad2.status, 400);
    assert.equal(bad2.body.code, "INVALID_MAC");
    const unknown = await lookup(rs, "DE:AD:BE:EF:00:01");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "DEVICE_NOT_FOUND");
    await M.Partner.update({ status: "suspended" }, { where: { id: rs.id } });
    const suspended = await lookup(rs, m);
    assert.equal(suspended.status, 403);
    assert.equal(suspended.body.code, "RESELLER_INACTIVE");
    const write = await configureAs(rs, m, { mode: "partner", confirm: true, code: content.code, username: "u1", password: "p1" });
    assert.equal(write.status, 403, "suspenso também não escreve");
    assert.equal(await M.Activation.count({ where: { deviceId: (await M.Device.findOne({ where: { mac: m } })).id } }), 0);
  });

  test("remover lista: lista própria mantém a licença; parceria libera o MAC sem apagar parceiro nem provedor", async () => {
    const content = await newPartner();
    const rs = await mkReseller();

    // parceria
    const regP = await register();
    const mP = regP.body.mac;
    assert.equal((await configureAs(rs, mP, { mode: "partner", confirm: true, code: content.code, username: "u1", password: "p1" })).status, 200);
    const providersBefore = await M.PartnerProvider.count({ where: { partnerId: content.id } });
    const removedP = await api("POST", "/api/v1/partner/mac/remove-list", { token: rs.token, body: { mac: mP, reason: "cliente pediu" } });
    assert.equal(removedP.status, 200, JSON.stringify(removedP.body));
    assert.equal(removedP.body.removed, true);
    assert.equal(removedP.body.mode, "partner");
    const devP = await M.Device.findOne({ where: { mac: mP } });
    assert.equal((await M.Activation.findAll({ where: { deviceId: devP.id } })).every((a) => a.status === "revoked"), true);
    assert.equal((await M.Partner.findByPk(content.id)).status, "active", "o parceiro de conteúdo não é afetado");
    assert.equal(await M.PartnerProvider.count({ where: { partnerId: content.id } }), providersBefore, "o provedor compartilhado não é apagado");
    assert.ok((await register(mP)).body.pairing, "a TV volta ao pareamento");
    assert.equal((await api("POST", "/api/v1/partner/mac/remove-list", { token: rs.token, body: { mac: mP } })).body.removed, false, "repetir é idempotente");

    // lista própria + licença
    const lic = await newLicense();
    const regL = await register();
    const mL = regL.body.mac;
    assert.equal((await activateLicense(lic.code, mL)).status, 201);
    const set = await configureAs(rs, mL, { mode: "playlist", confirm: true, name: "Lista X", url: `${providerBase}/external.m3u` });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const removedL = await api("POST", "/api/v1/partner/mac/remove-list", { token: rs.token, body: { mac: mL } });
    assert.equal(removedL.body.removed, true);
    assert.equal(removedL.body.mode, "playlist");
    const devL = await M.Device.findOne({ where: { mac: mL } });
    const actL = await M.Activation.findOne({ where: { deviceId: devL.id } });
    assert.equal(actL.status, "active", "a ativação da licença continua");
    assert.equal(actL.playlistUrlEnc, null);
    assert.equal((await M.License.findByPk(lic.id)).status, "active", "a licença não é afetada");
  });

  test("17. migrations multiplataforma: dispositivos ficam 'roku' e o gatilho preenche device_key", async () => {
    const m = mac();
    await register(m);
    const [rows] = await sequelize.query("SELECT platform, app_id, identifier_type, device_key, first_registered_at FROM devices WHERE mac = :m", { replacements: { m } });
    assert.equal(rows[0].platform, "roku");
    assert.equal(rows[0].identifier_type, "virtual_mac");
    assert.equal(rows[0].device_key, `roku:${m}`);
    assert.ok(rows[0].first_registered_at);
    const [t] = await sequelize.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('device_access_keys','device_scoped_sessions','catalog_imports','catalog_groups','catalog_series','catalog_items','license_events')`);
    assert.equal(t[0].n, 7);
  });

  test("admin pode atribuir/trocar listas e usuário sem permissão recebe 403", async () => {
    const m = mac();
    const registered = await register(m);
    const license = await newLicense();
    const activation = await activateLicense(license.code, m, { installationId: registered.body.installationId });
    const cancel = await api("POST", `/api/v1/admin/devices/registrations/${registered.body.deviceId}/configuration`, {
      token: adminToken, body: { mode: "playlist", confirm: false },
    });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.cancelled, true);
    const assigned = await api("POST", `/api/v1/admin/devices/registrations/${registered.body.deviceId}/configuration`, {
      token: adminToken,
      body: { mode: "playlist", confirm: true, name: "Admin list", url: `${providerBase}/external.m3u` },
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.listName, "Admin list");
    const cancelEvent = await M.AuditLog.findOne({
      where: { entityType: "device", entityId: registered.body.deviceId, action: "device.configuration.cancel" },
    });
    assert.ok(cancelEvent);
    assert.ok(cancelEvent.actorId);

    const partner = await newPartner();
    const changed = await api("POST", `/api/v1/admin/devices/registrations/${registered.body.deviceId}/configuration`, {
      token: adminToken,
      body: { mode: "partner", confirm: true, code: partner.code, username: "u1", password: "p1" },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.status, "configured_partner");
    const confirmEvent = await M.AuditLog.findOne({
      where: { entityType: "device", entityId: registered.body.deviceId, action: "device.configuration.confirm" },
      order: [["createdAt", "DESC"]],
    });
    assert.ok(confirmEvent);
    assert.ok(confirmEvent.createdAt);
    assert.ok(confirmEvent.actorId);
    assert.equal(confirmEvent.metadata.username, undefined);
    assert.equal(confirmEvent.metadata.password, undefined);
    const licenseAgain = await api("POST", `/api/v1/admin/devices/registrations/${registered.body.deviceId}/configuration`, {
      token: adminToken,
      body: { mode: "playlist", confirm: true, licenseCode: license.code, name: "Lista trocada", url: `${providerBase}/external.m3u` },
    });
    assert.equal(licenseAgain.status, 200, JSON.stringify(licenseAgain.body));
    assert.equal(licenseAgain.body.listName, "Lista trocada");
    const partnerToken = partner.token;
    const denied = await api("GET", "/api/v1/admin/devices/registrations", { token: partnerToken });
    assert.equal(denied.status, 403);
    const deniedWrite = await api("POST", `/api/v1/admin/devices/registrations/${registered.body.deviceId}/configuration`, {
      token: partnerToken, body: { mode: "playlist", confirm: true, name: "x", url: `${providerBase}/external.m3u` },
    });
    assert.equal(deniedWrite.status, 403);
    const detail = await api("GET", "/api/v1/admin/devices/registrations", { token: adminToken, headers: {} });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.data.some((d) => d.mac === m));
    assert.equal(JSON.stringify({ activation: activation.body, assigned: assigned.body, changed: changed.body }).includes("u1"), false);
  });

  test("URL de lista rejeita SSRF e revalida redirecionamentos", async () => {
    const license = await newLicense();
    const activation = await activateLicense(license.code);
    process.env.ALLOW_PRIVATE_SOURCES = "false";
    const blocked = await api("POST", "/api/v1/client/configure/playlist", {
      token: activation.body.tokens.accessToken,
      body: { name: "Nope", url: "http://user:pass@127.0.0.1/private.m3u" },
    });
    assert.equal(blocked.status, 400);
    assert.equal(JSON.stringify(blocked.body).includes("user"), false);
    assert.equal(JSON.stringify(blocked.body).includes("pass"), false);
    process.env.ALLOW_PRIVATE_SOURCES = "true";
    const redirected = safeGet(`${providerBase}/ssrf-redirect`, { timeoutMs: 1000 });
    await assert.rejects(redirected, /não permitido/i);
    process.env.ALLOW_PRIVATE_SOURCES = "true";
  });

  test("validação de ativação identifica campos Zod sem devolver segredos", async () => {
    const p = await newPartner();
    const response = await api("POST", "/api/v1/client/activate/partner", {
      body: { code: p.code, mac: mac(), username: "provider-user", password: "" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION_ERROR");
    assert.match(response.body.message, /senha|caracteres|campo/i);
    assert.ok(response.body.details.some((issue) => issue.path === "password"));
    assert.equal(JSON.stringify(response.body).includes("provider-user"), false);
  });

  test("2. rejeita licença expirada", async () => {
    const { id, code } = await newLicense();
    await M.License.update({ expiresAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86400000) }, { where: { id } });
    const r = await activateLicense(code);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "LICENSE_EXPIRED");
  });

  test("3. rejeita licença bloqueada", async () => {
    const { id, code } = await newLicense();
    assert.equal((await api("POST", `/api/v1/admin/licenses/${id}/block`, { token: adminToken, body: { reason: "fraude" } })).status, 200);
    const r = await activateLicense(code);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "LICENSE_BLOCKED");
  });

  test("4. ativação por código de parceria + usuário/senha, vínculo à parceria e playlist do provedor", async () => {
    const p = await newPartner();
    const r = await activatePartner(p.code);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.kind, "partner");
    assert.equal(JSON.stringify(r.body).includes(p.id), false, "o cliente final não deve ver dados da parceria");
    const act = await M.Activation.findByPk(r.body.activationId);
    assert.equal(act.partnerId, p.id, "dispositivo vinculado à parceria");
    assert.ok(act.providerId && act.credentialsEnc);
    assert.match(act.credentialsEnc, /^v1\./, "credenciais guardadas cifradas (AES-GCM), não em JSON puro");
    assert.equal(act.credentialsEnc.includes("username"), false);

    const cat = await api("GET", "/api/v1/client/catalog", { token: r.body.tokens.accessToken });
    assert.equal(cat.status, 200, JSON.stringify(cat.body));
    assert.equal(cat.body.items.length, 1);
    assert.match(cat.body.items[0].srcVideo, /^\/api\/v1\/play\/me\/p0\.ts$/);
    const blob = JSON.stringify(cat.body);
    assert.equal(blob.includes("u1/p1") || blob.includes(providerBase), false, "origem/credenciais não vão ao cliente");

    const play = await api("GET", `${cat.body.items[0].srcVideo}?t=${cat.body.playToken}`, { redirect: "manual" });
    assert.equal(play.status, 200);
    assert.equal(play.headers.get("location"), null, "credenciais do provedor não aparecem em um redirect");
    assert.equal(play.body, null);
  });

  test("4b. senha errada, código inexistente, revogado e expirado dão a MESMA resposta (sem oráculo de códigos)", async () => {
    const p = await newPartner();
    const unknown = await activatePartner("ZZZ99999");
    const wrongPass = await activatePartner(p.code, mac(), { password: "errada" });
    assert.equal(unknown.status, 401); assert.equal(wrongPass.status, 401);
    assert.deepEqual([unknown.body.code, unknown.body.message], [wrongPass.body.code, wrongPass.body.message]);
    assert.equal(unknown.body.code, "INVALID_CODE_OR_CREDENTIALS");
    const rev = await api("POST", `/api/v1/admin/partners/${p.id}/codes`, { token: adminToken, body: {} });
    await api("POST", `/api/v1/admin/partners/${p.id}/codes/${rev.body.id}/revoke`, { token: adminToken });
    assert.equal((await activatePartner(rev.body.code)).body.code, "INVALID_CODE_OR_CREDENTIALS");
    const exp = await api("POST", `/api/v1/admin/partners/${p.id}/codes`, { token: adminToken, body: { expiresAt: new Date(Date.now() + 60000).toISOString() } });
    await M.PartnerCode.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { id: exp.body.id } });
    assert.equal((await activatePartner(exp.body.code)).body.code, "INVALID_CODE_OR_CREDENTIALS");
    assert.equal(await M.Activation.count({ where: { partnerId: p.id } }), 0, "nada foi ativado");
  });

  test("4c. servidor do provedor fora do ar não ativa e não confunde com senha errada", async () => {
    const p = await newPartner({ providerBase: "http://127.0.0.1:1" });
    const r = await activatePartner(p.code);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, "PROVIDER_UNREACHABLE");
  });

  test("4d. fallback: usa o próximo servidor do provedor quando o primeiro recusa/está fora", async () => {
    const p = await newPartner({ providerBase: "http://127.0.0.1:1" });
    await api("POST", `/api/v1/admin/partners/${p.id}/providers`, { token: adminToken, body: { name: "Backup", baseUrl: providerBase, priority: 5 } });
    const r = await activatePartner(p.code);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const act = await M.Activation.findByPk(r.body.activationId, { include: [M.PartnerProvider] });
    assert.equal(act.PartnerProvider.name, "Backup");
  });

  test("4e. credenciais nunca aparecem nas APIs e são apagadas ao remover a ativação", async () => {
    const p = await newPartner();
    const a = await activatePartner(p.code);
    const list = await api("GET", `/api/v1/admin/partners/${p.id}/devices`, { token: adminToken });
    const detail = await api("GET", `/api/v1/admin/devices/activations/${a.body.activationId}`, { token: adminToken });
    for (const body of [list.body, detail.body]) {
      const t = JSON.stringify(body);
      assert.equal(t.includes("credentials") || t.includes("u1") || t.includes("p1\""), false);
    }
    await api("POST", `/api/v1/admin/devices/activations/${a.body.activationId}/revoke`, { token: adminToken, body: {} });
    assert.equal((await M.Activation.findByPk(a.body.activationId)).credentialsEnc, null);
  });

  test("4f. códigos de parceria: formato, escolha, geração e unicidade (inclusive sob concorrência)", async () => {
    const p1 = await newPartner(); const p2 = await newPartner();
    const chosen = `X${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const a = await api("POST", `/api/v1/admin/partners/${p1.id}/codes`, { token: adminToken, body: { code: chosen.toLowerCase() } });
    assert.equal(a.status, 201); assert.equal(a.body.code, chosen, "normalizado em maiúsculas");
    const dup = await api("POST", `/api/v1/admin/partners/${p2.id}/codes`, { token: adminToken, body: { code: chosen } });
    assert.equal(dup.status, 409); assert.equal(dup.body.code, "CODE_TAKEN");
    assert.equal((await api("POST", `/api/v1/admin/partners/${p2.id}/codes`, { token: adminToken, body: { code: "abc" } })).status, 400, "mínimo 4");
    assert.equal((await api("POST", `/api/v1/admin/partners/${p2.id}/codes`, { token: adminToken, body: { code: "AB CD" } })).body.code, "INVALID_CODE_FORMAT");
    assert.equal((await api("POST", `/api/v1/admin/partners/${p2.id}/codes`, { token: adminToken, body: { code: "OLD1234" } })).body.code, "INVALID_CODE_FORMAT");

    const check = (c) => api("GET", `/api/v1/admin/partners/codes/check?code=${c}`, { token: adminToken });
    assert.equal((await check(chosen)).body.available, false);
    assert.equal((await check("QWERT9")).body.available, true);
    assert.equal((await check("OLD123")).body.valid, false);

    const gens = await Promise.all(Array.from({ length: 8 }, () => api("POST", `/api/v1/admin/partners/${p1.id}/codes`, { token: adminToken, body: {} })));
    assert.ok(gens.every((g) => g.status === 201));
    const codes = gens.map((g) => g.body.code);
    assert.equal(new Set(codes).size, codes.length, "códigos gerados são distintos");
    assert.ok(codes.every((c) => /^\d{4,8}$/.test(c)));

    const same = `Y${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const race = await Promise.all([p1, p2].map((p) => api("POST", `/api/v1/admin/partners/${p.id}/codes`, { token: adminToken, body: { code: same } })));
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409], "só uma parceria fica com o código");
    assert.equal(await M.PartnerCode.count({ where: { code: same } }), 1);
  });

  test("5. parceria expirada ou suspensa rejeita a ativação", async () => {
    const p = await newPartner();
    await M.Partner.update({ endsAt: new Date(Date.now() - 1000) }, { where: { id: p.id } });
    assert.equal((await activatePartner(p.code)).body.code, "PARTNER_EXPIRED");
    const q = await newPartner();
    await api("POST", `/api/v1/admin/partners/${q.id}/suspend`, { token: adminToken, body: { reason: "teste" } });
    assert.equal((await activatePartner(q.code)).body.code, "PARTNER_SUSPENDED");
  });

  test("6. bloqueio de um dispositivo afeta somente ele", async () => {
    const { code } = await newLicense({ maxDevices: 2 });
    const a = await activateLicense(code);
    const b = await activateLicense(code);
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const blocked = await api("POST", `/api/v1/admin/devices/activations/${a.body.activationId}/block`, { token: adminToken, body: { reason: "teste" } });
    assert.equal(blocked.status, 200);
    assert.equal((await resources(a)).body.code, "DEVICE_BLOCKED");
    assert.equal((await resources(b)).status, 200);
    // status continua consultável (200) com allowed=false
    const st = await api("GET", "/api/v1/client/status", { token: a.body.tokens.accessToken });
    assert.equal(st.status, 200); assert.equal(st.body.allowed, false);
  });

  test("7 e 11. bloqueio de licença derruba todos os dispositivos; reativação os devolve", async () => {
    const { id, code } = await newLicense({ maxDevices: 3 });
    const acts = [await activateLicense(code), await activateLicense(code), await activateLicense(code)];
    await api("POST", `/api/v1/admin/licenses/${id}/block`, { token: adminToken, body: { reason: "chargeback" } });
    for (const a of acts) assert.equal((await resources(a)).body.code, "LICENSE_BLOCKED");
    await api("POST", `/api/v1/admin/licenses/${id}/reactivate`, { token: adminToken, body: {} });
    for (const a of acts) assert.equal((await resources(a)).status, 200);
  });

  test("8 e 11. bloqueio de parceria derruba clientes de códigos diferentes; reativação devolve", async () => {
    const p = await newPartner();
    const second = (await api("POST", `/api/v1/admin/partners/${p.id}/codes`, { token: adminToken, body: {} })).body.code;
    const acts = [await activatePartner(p.code), await activatePartner(second), await activatePartner(p.code)];
    await api("POST", `/api/v1/admin/partners/${p.id}/block`, { token: adminToken, body: { reason: "abuso" } });
    for (const a of acts) assert.equal((await resources(a)).body.code, "PARTNER_BLOCKED");
    await api("POST", `/api/v1/admin/partners/${p.id}/reactivate`, { token: adminToken, body: {} });
    for (const a of acts) assert.equal((await resources(a)).status, 200);
  });

  test("9. acesso é negado após a expiração da licença (mesmo com token válido)", async () => {
    const { id, code } = await newLicense();
    const a = await activateLicense(code);
    assert.equal((await resources(a)).status, 200);
    await M.License.update({ expiresAt: new Date(Date.now() - 1000), startsAt: new Date(Date.now() - 86400000) }, { where: { id } });
    assert.equal((await resources(a)).body.code, "LICENSE_EXPIRED");
    const refresh = await api("POST", "/api/v1/client/session/refresh", { body: { refreshToken: a.body.tokens.refreshToken } });
    assert.equal(refresh.status, 403);
  });

  test("10 e 11. inadimplência: tolerância, suspensão automática e reativação por pagamento", async () => {
    const p = await newPartner({ graceDays: 5 });
    const a = await activatePartner(p.code);
    const gen = await api("POST", `/api/v1/admin/partners/${p.id}/invoices`, { token: adminToken, body: { competence: new Date().toISOString().slice(0, 7) } });
    const invoiceId = gen.body.invoice.id;
    const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    await M.Invoice.update({ dueDate: ago(3) }, { where: { id: invoiceId } });
    assert.equal((await resources(a)).status, 200, "dentro da tolerância");
    await M.Invoice.update({ dueDate: ago(10) }, { where: { id: invoiceId } });
    assert.equal((await resources(a)).body.code, "PARTNER_DELINQUENT", "gate bloqueia sem esperar o job");
    const sweep = await api("POST", "/api/v1/admin/billing/sweep", { token: adminToken });
    assert.ok(sweep.body.suspended.includes(p.id));
    assert.equal((await M.Partner.findByPk(p.id)).status, "suspended");
    const pay = await api("POST", `/api/v1/admin/billing/invoices/${invoiceId}/payments`, { token: adminToken, body: { amountCents: 10000, method: "pix", reference: `pix-${Date.now()}` } });
    assert.equal(pay.status, 201);
    assert.equal(pay.body.reactivated, true);
    assert.equal((await resources(a)).status, 200);
  });

  test("webhook de pagamento exige assinatura, é idempotente e não confia no frontend", async () => {
    const p = await newPartner();
    const gen = await api("POST", `/api/v1/admin/partners/${p.id}/invoices`, { token: adminToken, body: { competence: new Date().toISOString().slice(0, 7) } });
    const payload = JSON.stringify({ eventId: `evt-${Date.now()}`, type: "payment.confirmed", invoiceId: gen.body.invoice.id, amountCents: 10000, providerRef: `ref-${Date.now()}` });
    const ts = String(Date.now());
    const sig = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET || "dev-only-webhook-secret").update(`${ts}.${payload}`).digest("hex");
    const bad = await api("POST", "/api/v1/webhooks/payments/generic", { raw: true, body: payload, headers: { "x-webhook-timestamp": ts, "x-webhook-signature": "00".repeat(32) } });
    assert.equal(bad.status, 401);
    const good = await api("POST", "/api/v1/webhooks/payments/generic", { raw: true, body: payload, headers: { "x-webhook-timestamp": ts, "x-webhook-signature": sig } });
    assert.equal(good.body.ok, true);
    const again = await api("POST", "/api/v1/webhooks/payments/generic", { raw: true, body: payload, headers: { "x-webhook-timestamp": ts, "x-webhook-signature": sig } });
    assert.equal(again.body.duplicate, true);
    assert.equal((await M.Invoice.findByPk(gen.body.invoice.id)).status, "paid");
  });

  test("12. ativações simultâneas não duplicam e respeitam o limite", async () => {
    const { code } = await newLicense({ maxDevices: 1 });
    const same = mac();
    const rs = await Promise.all(Array.from({ length: 8 }, () => activateLicense(code, same, { idempotencyKey: "mesma-chave-1" })));
    assert.ok(rs.every((r) => [200, 201].includes(r.status)), JSON.stringify(rs.map((r) => r.status)));
    assert.equal(await M.Activation.count({ where: { mac: same } }), 1);
    const other = await newLicense({ maxDevices: 1 });
    const many = await Promise.all(Array.from({ length: 6 }, () => activateLicense(other.code)));
    assert.equal(many.filter((r) => r.status === 201).length, 1);
    assert.ok(many.filter((r) => r.status !== 201).every((r) => r.body.code === "DEVICE_LIMIT_REACHED"));
  });

  test("12b. o mesmo MAC não ativa em duas licenças, mas pode ser transferido após revogar", async () => {
    const l1 = await newLicense(); const l2 = await newLicense();
    const m = mac();
    const first = await activateLicense(l1.code, m);
    assert.equal((await activateLicense(l2.code, m)).body.code, "MAC_IN_USE");
    await api("POST", `/api/v1/admin/devices/activations/${first.body.activationId}/revoke`, { token: adminToken, body: { reason: "troca" } });
    assert.equal((await resources(first)).status, 401, "sessões revogadas");
    assert.equal((await activateLicense(l2.code, m)).status, 201);
  });

  test("13. isolamento entre parceiros", async () => {
    const a = await newPartner(); const b = await newPartner();
    const devB = await activatePartner(b.code);
    const list = await api("GET", "/api/v1/partner/devices", { token: a.token });
    assert.equal(list.body.data.length, 0);
    for (const action of ["block", "revoke"]) {
      const r = await api("POST", `/api/v1/partner/devices/${devB.body.activationId}/${action}`, { token: a.token, body: { reason: "ataque" } });
      assert.equal(r.status, 404);
    }
    assert.equal((await api("GET", `/api/v1/partner/devices/${devB.body.activationId}`, { token: a.token })).status, 404);
    assert.equal((await resources(devB)).status, 200, "dispositivo do parceiro B intacto");
    const ownDev = await activatePartner(a.code);
    assert.equal((await api("POST", `/api/v1/partner/devices/${ownDev.body.activationId}/block`, { token: a.token, body: { reason: "inadimplente" } })).status, 200);
    // parceiro não desfaz bloqueio aplicado pela plataforma
    await api("POST", `/api/v1/admin/devices/activations/${ownDev.body.activationId}/unblock`, { token: adminToken });
    await api("POST", `/api/v1/admin/devices/activations/${ownDev.body.activationId}/block`, { token: adminToken, body: { reason: "plataforma" } });
    assert.equal((await api("POST", `/api/v1/partner/devices/${ownDev.body.activationId}/unblock`, { token: a.token })).status, 403);
  });

  test("14. permissões administrativas", async () => {
    assert.equal((await api("GET", "/api/v1/admin/licenses")).status, 401);
    const p = await newPartner();
    assert.equal((await api("GET", "/api/v1/admin/licenses", { token: p.token })).status, 403, "parceiro não acessa rotas admin");
    assert.equal((await api("GET", "/api/v1/partner/me", { token: adminToken })).status, 403, "admin não usa portal do parceiro");
    const u = await api("POST", "/api/v1/admin/users", { token: adminToken, body: { name: "Suporte", email: `s${Date.now()}@test.local`, password: "senha-suporte-123456", role: "support" } });
    assert.equal(u.status, 201);
    const login = await api("POST", "/api/v1/auth/login", { body: { email: u.body.email, password: "senha-suporte-123456" } });
    const support = login.body.accessToken;
    assert.equal((await api("GET", "/api/v1/admin/licenses", { token: support })).status, 200);
    assert.equal((await api("POST", "/api/v1/admin/licenses", { token: support, body: { planId: plans[0].id } })).status, 403);
    assert.equal((await api("GET", "/api/v1/admin/users", { token: support })).status, 403);
    assert.equal((await api("POST", "/api/v1/admin/licenses", { token: adminToken, body: { planId: "não-é-uuid" } })).body.code, "VALIDATION_ERROR");
  });

  test("15. URLs autorizadas deixam de funcionar após o bloqueio (e o cliente não vê a origem)", async () => {
    const src = await api("POST", "/api/v1/admin/sources", { token: adminToken, body: { name: "Catálogo teste", kind: "catalog", scope: "global" } });
    assert.equal(src.status, 201, JSON.stringify(src.body));
    const ch = await api("POST", `/api/v1/admin/sources/${src.body.id}/channels`, { token: adminToken, body: { name: "Canal 1", streamUrl: "http://93.184.216.34/live/1.ts" } });
    assert.equal(ch.status, 201, JSON.stringify(ch.body));
    process.env.ALLOW_PRIVATE_SOURCES = "false"; // valida o bloqueio de SSRF com a proteção ligada
    try {
      const bad = await api("POST", `/api/v1/admin/sources/${src.body.id}/channels`, { token: adminToken, body: { name: "SSRF", streamUrl: "http://127.0.0.1:8080/x" } });
      assert.equal(bad.body.code, "URL_NOT_ALLOWED");
      const badProv = await api("POST", `/api/v1/admin/partners/${(await newPartnerNoProvider()).id}/providers`, { token: adminToken, body: { name: "SSRF", baseUrl: "http://169.254.169.254" } });
      assert.equal(badProv.body.code, "URL_NOT_ALLOWED");
    } finally {
      process.env.ALLOW_PRIVATE_SOURCES = "true";
    }

    const { id, code } = await newLicense();
    const a = await activateLicense(code);
    const cat = await api("GET", "/api/v1/client/catalog", { token: a.body.tokens.accessToken });
    assert.equal(cat.status, 200);
    assert.equal(JSON.stringify(cat.body).includes("93.184.216.34"), false, "origem nunca vai ao cliente");
    const item = cat.body.items[0];
    const play = `${item.srcVideo}?t=${cat.body.playToken}`;
    const ok = await api("GET", play.replace(/^\/api/, "/api"), { redirect: "manual" });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "http://93.184.216.34/live/1.ts");
    await api("POST", `/api/v1/admin/licenses/${id}/block`, { token: adminToken, body: { reason: "teste" } });
    const denied = await api("GET", play, { redirect: "manual" });
    assert.equal(denied.status, 403, "o mesmo token já emitido deixa de ser aceito");
    assert.equal(denied.body.code, "LICENSE_BLOCKED");
    const noToken = await api("GET", item.srcVideo, { redirect: "manual" });
    assert.equal(noToken.status, 401);
  });

  test("auditoria registra operações administrativas sem vazar códigos", async () => {
    const { id } = await newLicense();
    await api("POST", `/api/v1/admin/licenses/${id}/suspend`, { token: adminToken, body: { reason: "teste" } });
    const log = await api("GET", `/api/v1/admin/audit?entityType=license&entityId=${id}`, { token: adminToken });
    assert.ok(log.body.data.some((e) => e.action === "license.suspend" && e.actorName));
    assert.equal(JSON.stringify(log.body).includes("LIC-"), false);
  });

  test("brute force no login bloqueia a conta temporariamente", async () => {
    const u = await api("POST", "/api/v1/admin/users", { token: adminToken, body: { name: "Alvo", email: `alvo${Date.now()}@test.local`, password: "senha-alvo-1234567", role: "support" } });
    let last;
    for (let i = 0; i < 5; i++) last = await api("POST", "/api/v1/auth/login", { body: { email: u.body.email, password: "errada" } });
    assert.equal(last.status, 401);
    const locked = await api("POST", "/api/v1/auth/login", { body: { email: u.body.email, password: "senha-alvo-1234567" } });
    assert.equal(locked.status, 429);
  });
});
