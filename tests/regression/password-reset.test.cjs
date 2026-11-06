"use strict";
// Regressão sem dependências: o código real é executado com banco, SMTP e audit simulados.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createHash } = require("node:crypto");

const filepath = path.resolve(__dirname, "../../src/modules/auth/password-reset.service.js");
const source = fs.readFileSync(filepath, "utf8");
const imports = [...source.matchAll(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];/g)].map(m => ({ spec: m[2], names: m[1].split(",").map(p => p.trim().split(/\s+as\s+/)[0]) }));
const hash = s => createHash("sha256").update(s).digest("hex");

async function load({ role = "partner", partnerKind = "content", status = "active", smtpFailure = false } = {}) {
  const mails = [], audits = [], revoked = [], disconnected = [];
  let currentToken = "";
  const user = {
    id: "u-1", partnerId: role === "partner" ? "p-1" : null, name: "Conta Teste", email: "test@example.com", status, role,
    passwordHash: "old", passwordResetHash: null, passwordResetExpiresAt: null, passwordResetIssuedAt: null,
    async update(patch) { Object.assign(this, patch); return this; },
  };
  const AdminUser = {
    async findByPk(id) { return id === user.id ? user : null; },
    async findOne({ where }) {
      if (where.kind === "email") return where.email === user.email ? user : null;
      if (where.passwordResetHash) {
        return user.passwordResetHash === where.passwordResetHash && user.status === where.status && new Date(user.passwordResetExpiresAt || 0) > new Date() ? user : null;
      }
      return null;
    },
    async update(patch, { where }) {
      if (where.id === user.id && where.passwordResetHash === user.passwordResetHash) { Object.assign(user, patch); return [1]; }
      return [0];
    },
  };
  const stubs = {
    "sequelize": { Op: { gt: Symbol("gt") } },
    "../../db/models/index.js": {
      sequelize: { transaction: async f => f({ LOCK: { UPDATE: "UPDATE" } }),
        where: (_lower, email) => ({ kind: "email", email }), fn: () => null, col: () => null },
      AdminUser, Partner: { findByPk: async id => id === "p-1" ? { kind: partnerKind } : null },
    },
    "../../config/env.js": { env: { mail: { configured: true }, partnerPortalUrl: "https://parceiro.example", adminPanelUrl: "https://admin.example", resellerPortalUrl: "https://revenda.example" } },
    "../../shared/errors.js": { AppError: class AppError extends Error { constructor(status, code, msg) { super(msg); this.status = status; this.code = code; } }, notFound: msg => new Error(msg) },
    "../../shared/crypto.js": { hashPassword: async s => `hashed:${s}`, randomToken: () => (currentToken = "random-secret-example-0000000000000000000000000000000000000000000000000000"), sha256: hash },
    "../../shared/audit.js": { audit: async record => { audits.push(record); } },
    "../mail/mail.transport.js": { assertConfigured: () => {}, sendMail: async mail => { if (smtpFailure) throw Error("SMTP unavailable"); mails.push(mail); } },
    "./auth.service.js": { revokeAllSessions: async id => revoked.push(id) },
    "../../realtime/socket.js": { disconnectAdminUser: id => disconnected.push(id) },
  };
  const context = vm.createContext({ console, Date, URL, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, identifier: filepath });
  await module.link(spec => {
    const entry = imports.find(i => i.spec === spec);
    assert.ok(entry, `import ${spec}`);
    return new vm.SyntheticModule(entry.names, function () {
      for (const name of entry.names) this.setExport(name, stubs[spec][name]);
    }, { context });
  });
  await module.evaluate();
  return { svc: module.namespace, user, mails, audits, revoked, disconnected, token: () => currentToken };
}

test("pedido público envia uma única mensagem; o banco só armazena hash e auditoria não registra token", async () => {
  const o = await load();
  assert.equal((await o.svc.requestPasswordReset("TEST@example.com")).ok, true);
  assert.equal(o.mails.length, 1);
  assert.equal(o.user.passwordResetHash, hash(o.token()));
  assert.ok(!JSON.stringify(o.audits).includes(o.token()));
  assert.ok(o.mails[0].text.includes(`/redefinir-senha#token=${o.token()}`));
  assert.ok(!o.user.passwordResetHash.includes(o.token()));
  await o.svc.requestPasswordReset("test@example.com");
  assert.equal(o.mails.length, 1, "cooldown evita envio duplicado");
});

test("endereço desconhecido recebe resposta genérica sem e-mail", async () => {
  const o = await load();
  const r = await o.svc.requestPasswordReset("unknown@example.com");
  assert.equal(r.ok, true);
  assert.equal(o.mails.length, 0);
});

test("redefinição encerra sessões, invalida token e impede segundo uso", async () => {
  const o = await load();
  await o.svc.sendPasswordResetToUser(o.user.id, { type: "admin", id: "admin-1" });
  assert.equal((await o.svc.completePasswordReset(o.token(), "strong-password-12")).ok, true);
  assert.equal(o.user.passwordHash, "hashed:strong-password-12");
  assert.equal(o.user.passwordResetHash, null);
  assert.deepEqual(o.revoked, [o.user.id]);
  assert.deepEqual(o.disconnected, [o.user.id]);
  await assert.rejects(() => o.svc.completePasswordReset(o.token(), "another-pass-123"), e => e.code === "INVALID_RESET_TOKEN");
});

test("token expirado é recusado", async () => {
  const o = await load();
  await o.svc.sendPasswordResetToUser(o.user.id, {});
  o.user.passwordResetExpiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => o.svc.completePasswordReset(o.token(), "strong-password-12"), e => e.code === "INVALID_RESET_TOKEN");
  assert.equal(o.user.passwordHash, "old");
});

test("SMTP com falha invalida o token e informa quem está autenticado", async () => {
  const o = await load({ smtpFailure: true });
  await assert.rejects(() => o.svc.sendPasswordResetToUser(o.user.id, {}), e => e.code === "PASSWORD_RESET_MAIL_FAILED");
  assert.equal(o.user.passwordResetHash, null);
  assert.equal(o.user.passwordResetIssuedAt, null);
  const r = await o.svc.requestPasswordReset("test@example.com");
  assert.equal(r.ok, true);
});

test("link escolhido pelo backend: admin, parceiro de conteúdo, revenda", async () => {
  const o = await load();
  assert.equal(o.svc.resetLinkForRole("superadmin", "abc").startsWith("https://admin.example"), true);
  assert.equal(o.svc.resetLinkForRole("partner", "abc", "content").startsWith("https://parceiro.example"), true);
  assert.equal(o.svc.resetLinkForRole("partner", "abc", "reseller").startsWith("https://revenda.example"), true);
  assert.equal(o.svc.resetLinkForRole("partner", "abc", "reseller").includes("#token=abc"), true);
});

test("usuário desativado não recebe redefinição autenticada", async () => {
  const o = await load({ status: "disabled" });
  await assert.rejects(() => o.svc.sendPasswordResetToUser(o.user.id, {}));
  assert.equal(o.mails.length, 0);
});

test("pedido público de revendedor não é aceito no login de parceiro de conteúdo", async () => {
  const o = await load({ partnerKind: "reseller" });
  assert.equal((await o.svc.requestPasswordReset("test@example.com")).ok, true);
  assert.equal(o.mails.length, 0);
});
