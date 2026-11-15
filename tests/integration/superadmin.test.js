import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
if (!process.env.DATABASE_URL_TEST)
  throw new Error(
    "Use DATABASE_URL_TEST de um banco descartável já migrado. Este teste não apaga o banco.",
  );
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.RATE_LIMIT_DISABLED = "true";
const { createApp } = await import("../../src/app.js");
const db = await import("../../src/db/models/index.js");
const { hashPassword } = await import("../../src/shared/crypto.js");
let server,
  base,
  rootAuth,
  supportAuth,
  adminAuth,
  partnerAuth,
  root,
  support,
  admin,
  partnerUser,
  otherUser,
  p1,
  p2,
  plan,
  roleId,
  grant,
  batch,
  backup,
  preview;
const suffix = randomUUID().slice(0, 8),
  password = "Only-for-local-tests-2026!";
async function request(path, { auth = rootAuth, method = "GET", body } = {}) {
  const response = await fetch(base + "/api/v1" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
}
async function login(user, audience = "admin") {
  const result = await request("/auth/login", {
    auth: null,
    method: "POST",
    body: { email: user.email, password, audience },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
before(async () => {
  const hash = await hashPassword(password),
    now = Date.now();
  await db.PlatformSetting.upsert({
    key: "superadmin.controls",
    value: {
      maintenance: false,
      maintenanceMessage: "Manutenção",
      brand: { name: "DeltaTV", logoUrl: "", primaryColor: "#7768f6" },
      terms: "",
      integrations: [],
    },
  });
  p1 = await db.Partner.create({
    name: `Revenda ${suffix}`,
    slug: `test-a-${suffix}`,
    kind: "both",
    startsAt: new Date(now - 86400000),
    endsAt: new Date(now + 365 * 86400000),
    billingModel: "none",
  });
  p2 = await db.Partner.create({
    name: `Parceiro ${suffix}`,
    slug: `test-b-${suffix}`,
    kind: "both",
    startsAt: new Date(now - 86400000),
    endsAt: new Date(now + 365 * 86400000),
    billingModel: "none",
  });
  const user = (name, role, partnerId = null) =>
    db.AdminUser.create({
      name,
      email: `${name.toLowerCase()}-${suffix}@example.test`,
      passwordHash: hash,
      role,
      partnerId,
    });
  root = await user("Root", "superadmin");
  support = await user("Support", "support");
  admin = await user("Admin", "admin");
  partnerUser = await user("Partner", "partner", p1.id);
  otherUser = await user("Other", "partner", p2.id);
  plan = await db.Plan.create({
    code: `test-${suffix}`,
    name: "Plano de teste",
    durationMonths: 1,
    maxDevices: 2,
    priceCents: 1234,
  });
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
  rootAuth = await login(root);
  supportAuth = await login(support);
  adminAuth = await login(admin);
  partnerAuth = await login(partnerUser, "partner");
});
after(async () => {
  if (process.env.DEMO_CREDENTIAL_PATH) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      process.env.DEMO_CREDENTIAL_PATH,
      JSON.stringify({
        email: root.email,
        password,
        partnerEmail: otherUser.email,
        partnerId: p2.id,
      }),
      { mode: 0o600 },
    );
  }
  await new Promise((r) => server.close(r));
  await db.sequelize.close();
});
test("control API denies anonymous, support, admin and partners", async () => {
  for (const auth of [null, supportAuth, adminAuth, partnerAuth])
    assert.ok(
      [401, 403].includes(
        (await request("/admin/control/roles", { auth })).status,
      ),
    );
  assert.equal((await request("/admin/control/roles")).status, 200);
});
test("batch issuance is atomic, trial duration is exact and retries are idempotent", async () => {
  const input = {
    planId: plan.id,
    count: 2,
    trialHours: 24,
    ownerPartnerId: p1.id,
    idempotencyKey: randomUUID(),
    reason: "Teste de emissão em lote",
  };
  const first = await request("/admin/control/licenses/batch", {
    method: "POST",
    body: input,
  });
  assert.equal(first.status, 201, JSON.stringify(first));
  batch = first.data.data;
  assert.equal(batch.length, 2);
  const row = await db.License.findByPk(batch[0].id);
  assert.equal(row.expiresAt - row.startsAt, 24 * 3600000);
  assert.equal(row.isTrial, true);
  const second = await request("/admin/control/licenses/batch", {
    method: "POST",
    body: input,
  });
  assert.equal(second.status, 200);
  assert.deepEqual(second.data.data, batch);
  assert.equal(
    (
      await request("/admin/control/licenses/batch", {
        method: "POST",
        body: { ...input, count: 3 },
      })
    ).status,
    409,
  );
});
test("manual expiry can extend, reduce and transfer an independent license with audit", async () => {
  const id = batch[0].id,
    previous = (await db.License.findByPk(id)).expiresAt;
  const result = await request(`/admin/control/licenses/${id}`, {
    method: "PATCH",
    body: {
      deltaDays: 3,
      ownerPartnerId: p2.id,
      reason: "Transferência e extensão de teste",
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  let row = await db.License.findByPk(id);
  assert.equal(row.expiresAt - previous, 3 * 86400000);
  assert.equal(row.ownerPartnerId, p2.id);
  assert.equal(
    (
      await request(`/admin/control/licenses/${id}`, {
        method: "PATCH",
        body: { deltaDays: -1, reason: "Redução de prazo de teste" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/admin/control/licenses/${id}`, {
        method: "PATCH",
        body: { deltaDays: -100, reason: "Redução abaixo do início" },
      })
    ).status,
    422,
  );
});
test("device limits count direct and granted activations; transfer cannot silently change content ownership", async () => {
  const id = batch[1].id;
  for (let i = 0; i < 2; i++) {
    const mac =
      "DA:11:22:" +
      randomUUID()
        .replaceAll("-", "")
        .slice(0, 6)
        .match(/../g)
        .join(":")
        .toUpperCase();
    const device = await db.Device.create({
      mac,
      lastInstallationId: randomUUID(),
    });
    await db.Activation.create({
      deviceId: device.id,
      mac,
      installationId: device.lastInstallationId,
      ...(i ? { partnerId: p1.id, grantedLicenseId: id } : { licenseId: id }),
    });
  }
  assert.equal(
    (
      await request(`/admin/control/licenses/${id}`, {
        method: "PATCH",
        body: { maxDevices: 1, reason: "Reduzir limite abaixo dos vínculos" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/admin/control/licenses/${id}`, {
        method: "PATCH",
        body: {
          ownerPartnerId: p2.id,
          reason: "Transferência sem reconfigurar conteúdo",
        },
      })
    ).status,
    409,
  );
});
test("license session caps invalidate excess authenticated device sessions", async () => {
  const activation = await db.Activation.findOne({
    where: { licenseId: batch[1].id },
  });
  for (let i = 0; i < 3; i++)
    await db.DeviceSession.create({
      activationId: activation.id,
      refreshHash: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      expiresAt: new Date(Date.now() + 86400000),
    });
  const r = await request(`/admin/control/licenses/${batch[1].id}`, {
    method: "PATCH",
    body: {
      maxSessionsPerActivation: 1,
      reason: "Limitar sessões do dispositivo de teste",
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(
    await db.DeviceSession.count({
      where: { activationId: activation.id, revokedAt: null },
    }),
    1,
  );
});
test("license status/trial filtering and CSV export respect effective expiry", async () => {
  const result = await request(
    "/admin/licenses?isTrial=true&sortBy=expiresAt&sortDir=ASC",
  );
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.ok(result.data.data.every((x) => x.isTrial));
  const csv = await request("/admin/control/licenses/export?status=trial");
  assert.equal(csv.status, 200);
  assert.ok(csv.data.content.includes(batch[0].id));
  assert.ok(!csv.data.content.includes(batch[0].code));
});
test("custom roles cannot escalate, revoke existing sessions and limit admin/portal actions", async () => {
  assert.equal(
    (
      await request("/admin/control/roles", {
        method: "POST",
        body: {
          name: "Escalation " + suffix,
          baseRole: "support",
          permissions: ["*"],
          reason: "Tentativa inválida de escalada",
        },
      })
    ).status,
    422,
  );
  const role = await request("/admin/control/roles", {
    method: "POST",
    body: {
      name: "Sem permissões " + suffix,
      baseRole: "support",
      permissions: [],
      reason: "Papel restrito para teste",
    },
  });
  assert.equal(role.status, 201, JSON.stringify(role));
  roleId = role.data.id;
  assert.equal(
    (
      await request(`/admin/control/users/${support.id}/role`, {
        method: "PUT",
        body: { roleId, reason: "Atribuir papel restrito" },
      })
    ).status,
    200,
  );
  assert.equal((await request("/auth/me", { auth: supportAuth })).status, 401);
  supportAuth = await login(support);
  assert.equal(
    (await request("/admin/licenses", { auth: supportAuth })).status,
    403,
  );
  assert.equal(
    (
      await request("/admin/control/roles/" + roleId, {
        method: "DELETE",
        body: { reason: "Papel ainda está em uso" },
      })
    ).status,
    409,
  );
  const pRole = await request("/admin/control/roles", {
    method: "POST",
    body: {
      name: "Clientes leitura " + suffix,
      baseRole: "partner",
      permissions: ["partner:clients:read"],
      reason: "Leitura isolada no portal",
    },
  });
  assert.equal(pRole.status, 201);
  await request(`/admin/control/users/${partnerUser.id}/role`, {
    method: "PUT",
    body: { roleId: pRole.data.id, reason: "Aplicar leitura de clientes" },
  });
  partnerAuth = await login(partnerUser, "partner");
  assert.equal(
    (await request("/partner/clients", { auth: partnerAuth })).status,
    200,
  );
  assert.equal(
    (
      await request("/partner/clients", {
        auth: partnerAuth,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (await request("/admin/licenses", { auth: partnerAuth })).status,
    403,
  );
});
test("impersonation is scoped to target, audited as original actor and revocable", async () => {
  const result = await request("/admin/control/impersonations", {
    method: "POST",
    body: {
      targetUserId: otherUser.id,
      portal: "content_partner",
      reason: "Atendimento do parceiro para teste",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result));
  grant = result.data;
  const me = await request("/auth/me", { auth: grant });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, otherUser.id);
  assert.equal(me.data.user.partnerId, p2.id);
  assert.equal(
    (await request("/admin/control/roles", { auth: grant })).status,
    403,
  );
  await request("/auth/profile/preferences", {
    auth: grant,
    method: "PATCH",
    body: { showUnreadBanner: false, showNotificationBadge: true },
  });
  const entry = await db.AuditLog.findOne({
    where: { action: "profile.preferences.update", actorId: root.id },
    order: [["id", "DESC"]],
  });
  assert.equal(entry.metadata.impersonatedUserId, otherUser.id);
  assert.equal(
    (await request("/auth/impersonation/end", { auth: grant, method: "POST" }))
      .status,
    204,
  );
  assert.equal((await request("/auth/me", { auth: grant })).status, 401);
});
test("global session revocation invalidates access tokens without revoking the source root", async () => {
  const sessions = await request("/admin/control/sessions?userId=" + admin.id);
  assert.equal(sessions.status, 200, JSON.stringify(sessions));
  assert.ok(sessions.data.data.length);
  const id = sessions.data.data[0].id;
  assert.equal(
    (
      await request(`/admin/control/sessions/${id}/revoke`, {
        method: "POST",
        body: { reason: "Encerrar sessão administrativa de teste" },
      })
    ).status,
    200,
  );
  assert.equal((await request("/auth/me", { auth: adminAuth })).status, 401);
  assert.equal((await request("/auth/me")).status, 200);
});
test("last superadmin/self protections and logical deletion preserve audit history", async () => {
  assert.equal(
    (
      await request(`/admin/users/${root.id}`, {
        method: "PATCH",
        body: { status: "disabled" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/admin/control/users/${root.id}`, {
        method: "DELETE",
        body: {
          reason: "Não pode excluir a própria conta",
          confirmation: "EXCLUIR USUÁRIO",
        },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/admin/control/users/${admin.id}`, {
        method: "DELETE",
        body: {
          reason: "Excluir conta administrativa de teste",
          confirmation: "EXCLUIR USUÁRIO",
        },
      })
    ).status,
    204,
  );
  const row = await db.AdminUser.findByPk(admin.id);
  assert.ok(row.deletedAt);
  const users = await request("/admin/users?q=" + admin.email);
  assert.equal(users.data.data.length, 0);
});
test("financial receipts include Pix without double counting linked payments", async () => {
  const pay = await db.Payment.create({
    licenseId: batch[0].id,
    amountCents: 12345,
    provider: "manual",
    origin: "admin",
    status: "confirmed",
  });
  const common = {
    quantity: 50,
    unitPriceCents: 100,
    partnerId: p1.id,
    purpose: "credit",
    provider: "mock",
    status: "paid",
    expiresAt: new Date(Date.now() + 86400000),
    paidAt: new Date(),
  };
  await db.PixCharge.create({
    ...common,
    amountCents: 5000,
    paidAmountCents: 5000,
  });
  await db.PixCharge.create({
    ...common,
    amountCents: 12345,
    paidAmountCents: 12345,
    paymentId: pay.id,
  });
  const r = await request("/admin/control/reports?partnerId=" + p1.id);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(Number(r.data.finance.revenueCents), 5000);
  assert.equal(r.data.clients.active,2);
  const other = await request("/admin/control/reports?partnerId=" + p2.id);
  assert.equal(Number(other.data.finance.revenueCents), 12345);
});
test("raw SQL credit adjustments atomically audit actual before/after values with the root actor", async () => {
  const result = await request(`/admin/credits/wallets/${p1.id}/adjust`, {
    method: "POST",
    body: { delta: 7, note: "Ajuste de integração com trilha no banco" },
  });
  assert.equal(result.status, 200, JSON.stringify(result));
  const entry = await db.AuditLog.findOne({
    where: {
      actorId: root.id,
      entityType: "credit_wallets",
      action: "record.sql.update",
    },
    order: [["id", "DESC"]],
  });
  assert.ok(entry);
  assert.equal(Number(entry.metadata.before.balance), 0);
  assert.equal(Number(entry.metadata.after.balance), 7);
  assert.ok(entry.metadata.requestId);
  assert.ok(entry.ip);
});
test("reports reject invalid periods and return reconciled daily/aggregate totals", async () => {
  assert.equal(
    (
      await request(
        "/admin/control/reports?from=2027-01-02T00:00:00Z&to=2027-01-01T00:00:00Z",
      )
    ).status,
    422,
  );
  const r = await request("/admin/control/reports");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(
    r.data.daily.reduce((n, x) => n + Number(x.revenueCents), 0),
    Number(r.data.finance.revenueCents),
  );
});
test("TV messages are mounted in the application and require authentication", async () => {
  assert.equal(
    (await request("/tv-messages/recipients", { auth: null })).status,
    401,
  );
  const r = await request("/tv-messages/recipients");
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.data.total >= 2);
});
test("playlist upload requires a device-scoped session and rejects another MAC before probing", async () => {
  const { sha256 } = await import("../../src/shared/crypto.js");
  const device = await db.Device.findOne();
  const token = randomUUID().replaceAll("-", "").repeat(2);
  await db.DeviceScopedSession.create({
    deviceId: device.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 60000),
  });
  const body = {
    mac: "AA:BB:CC:DD:EE:FF",
    name: "Lista indevida",
    url: "https://example.test/list",
  };
  assert.equal(
    (
      await request("/client/playlist/by-url", {
        auth: null,
        method: "POST",
        body,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/client/playlist/by-url", {
        auth: { accessToken: token },
        method: "POST",
        body,
      })
    ).status,
    403,
  );
});
test("payment credentials configured in the encrypted vault control the runtime Pix provider", async () => {
  const common = {
    maintenance: false,
    maintenanceMessage: "Manutenção de teste",
    brand: { name: "DeltaTV", primaryColor: "#7768f6", logoUrl: "" },
    terms: "",
    reason: "Validar configuração de provedor sem cobrar",
  };
  const invalid = await request("/admin/control/settings", {
    method: "PUT",
    body: {
      ...common,
      integrations: [{ name: "mercadopago", enabled: true, secret: "invalid" }],
    },
  });
  assert.equal(invalid.status, 422);
  const secret = JSON.stringify({
    accessToken: "TEST_ONLY_NOT_A_REAL_TOKEN",
    webhookSecret: "TEST_ONLY_NOT_A_REAL_SECRET",
  });
  assert.equal(
    (
      await request("/admin/control/settings", {
        method: "PUT",
        body: {
          ...common,
          integrations: [{ name: "mercadopago", enabled: true, secret }],
        },
      })
    ).status,
    200,
  );
  const enabled = await request("/admin/pix/config");
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.provider, "mercadopago");
  assert.equal(enabled.data.enabled, true);
  assert.ok(!JSON.stringify(enabled.data).includes("TEST_ONLY"));
  await request("/admin/control/settings", {
    method: "PUT",
    body: {
      ...common,
      integrations: [{ name: "mercadopago", enabled: false }],
    },
  });
  assert.equal((await request("/admin/pix/config")).data.enabled, false);
});
test("the player/Roku message path delivers and acknowledges only its own device inbox", async () => {
  const { signJwt } = await import("../../src/shared/crypto.js");
  const a = await db.Activation.findOne({ where: { licenseId: batch[1].id } }),
    session = await db.DeviceSession.findOne({
      where: { activationId: a.id, revokedAt: null },
    });
  const auth = {
    accessToken: signJwt({ typ: "device", aid: a.id, sid: session.id }, 600),
  };
  const created = await request("/tv-messages", {
    method: "POST",
    body: {
      audience: "selected",
      deviceIds: [a.deviceId],
      title: "Mensagem de integração",
      message: "Comunicado enviado apenas à TV de teste.",
      expiresInDays: 1,
      requestId: randomUUID(),
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created));
  const inbox = await request("/client/messages", { auth });
  assert.equal(inbox.status, 200, JSON.stringify(inbox));
  assert.ok(inbox.data.data.some((x) => x.id === created.data.id));
  assert.equal(
    (
      await request("/client/messages/" + created.data.id + "/read", {
        auth,
        method: "POST",
        body: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/client/messages", { auth })).data.data.length,
    0,
  );
});
test("global settings encrypt secrets and maintenance blocks portal mutations", async () => {
  const controls = {
    maintenance: true,
    maintenanceMessage: "Manutenção de teste em andamento.",
    brand: { name: "DeltaTV Teste", primaryColor: "#7768f6", logoUrl: "" },
    terms: "Termos de teste.",
    integrations: [
      { name: "sandbox", enabled: true, secret: "THIS-MUST-REMAIN-ENCRYPTED" },
    ],
    reason: "Ativar manutenção para testar importação",
  };
  const r = await request("/admin/control/settings", {
    method: "PUT",
    body: controls,
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.integrations[0].configured, true);
  assert.ok(!JSON.stringify(r.data).includes("THIS-MUST-REMAIN-ENCRYPTED"));
  const row = await db.PlatformSetting.findByPk("superadmin.controls");
  assert.ok(!JSON.stringify(row.value).includes("THIS-MUST-REMAIN-ENCRYPTED"));
  const mutation = await request("/partner/clients", {
    auth: partnerAuth,
    method: "POST",
    body: {},
  });
  assert.equal(mutation.status, 503);
});
test("encrypted backup authenticates password, previews before import and merges transactionally", async () => {
  const password = "Backup-test-only-long-password";
  const r = await request("/admin/control/data/export", {
    method: "POST",
    body: { password, reason: "Backup cifrado para integração" },
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  backup = r.data.backup;
  assert.ok(!JSON.stringify(backup).includes(root.email));
  assert.equal(
    (
      await request("/admin/control/data/import/preview", {
        method: "POST",
        body: { backup, password: "wrong-password-is-long-enough" },
      })
    ).status,
    422,
  );
  const p = await request("/admin/control/data/import/preview", {
    method: "POST",
    body: { backup, password },
  });
  assert.equal(p.status, 200, JSON.stringify(p));
  preview = p.data;
  assert.ok(preview.tables.length > 20);
  const apply = await request("/admin/control/data/import/apply", {
    method: "POST",
    body: {
      backup,
      password,
      expectedHash: preview.hash,
      reason: "Restaurar dados no banco descartável",
      confirmation: "IMPORTAR BACKUP",
    },
  });
  assert.equal(apply.status, 200, JSON.stringify(apply));
  assert.ok(apply.data.imported > 0);
  assert.equal((await request("/auth/me")).status, 200);
});
