import { Op } from "sequelize";
import { sequelize, AdminUser, AuthSession } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { hashPassword, verifyPassword, signJwt, randomToken, sha256 } from "../../shared/crypto.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
let dummyHash;

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, partnerId: u.partnerId });

async function issue(user, meta, transaction) {
  const refreshToken = randomToken(48);
  await AuthSession.create(
    {
      adminUserId: user.id,
      refreshHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.adminRefreshTtlDays * 86400000),
      ip: meta.ip,
      userAgent: (meta.userAgent || "").slice(0, 300),
    },
    { transaction },
  );
  return {
    accessToken: signJwt({ typ: "admin", sub: user.id, tv: user.tokenVersion }, env.adminAccessTtl),
    refreshToken,
    expiresIn: env.adminAccessTtl,
    user: publicUser(user),
  };
}

export async function login({ email, password, audience }, meta) {
  const user = await AdminUser.findOne({
    where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email.toLowerCase()),
  });
  const actor = { type: "anonymous", id: user?.id ?? null, ip: meta.ip };

  if (!user || user.status !== "active") {
    dummyHash ??= await hashPassword("dummy-password-for-timing");
    await verifyPassword(password, dummyHash); // iguala o tempo de resposta
    await audit({ actor, action: "auth.login", entityType: "admin_user", result: "failure", metadata: { reason: "unknown_or_disabled" } });
    throw new AppError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ actor, action: "auth.login", entityType: "admin_user", entityId: user.id, result: "failure", metadata: { reason: "locked" } });
    throw new AppError(429, "ACCOUNT_LOCKED", "Conta temporariamente bloqueada por tentativas inválidas.");
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED;
    await user.update({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null });
    await audit({ actor, action: "auth.login", entityType: "admin_user", entityId: user.id, result: "failure", metadata: { reason: "bad_password", locked: lock } });
    throw new AppError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
  }
  // Painel admin x portal do revendedor: a senha estava certa, mas a conta é do outro painel.
  if (audience && (audience === "partner") !== (user.role === "partner")) {
    await audit({ actor, action: "auth.login", entityType: "admin_user", entityId: user.id, result: "failure", metadata: { reason: "wrong_audience", audience } });
    throw new AppError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
  }
  await user.update({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() });
  const result = await issue(user, meta);
  await audit({ actor: { type: "admin", id: user.id, ip: meta.ip }, action: "auth.login", entityType: "admin_user", entityId: user.id });
  return result;
}

// Refresh com rotação: o token antigo deixa de valer após o uso.
export async function refresh(refreshToken, meta) {
  return sequelize.transaction(async (t) => {
    const session = await AuthSession.findOne({
      where: { refreshHash: sha256(refreshToken), revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!session) throw new AppError(401, "INVALID_TOKEN", "Sessão inválida ou expirada.");
    const user = await AdminUser.findByPk(session.adminUserId, { transaction: t });
    if (!user || user.status !== "active") throw new AppError(401, "INVALID_TOKEN", "Sessão inválida ou expirada.");
    await session.update({ revokedAt: new Date() }, { transaction: t });
    return issue(user, meta, t);
  });
}

export async function logout(refreshToken) {
  if (!refreshToken) return;
  await AuthSession.update({ revokedAt: new Date() }, { where: { refreshHash: sha256(refreshToken), revokedAt: null } });
}

// Invalida TODAS as sessões do usuário (access tokens via tokenVersion + refresh tokens).
export async function revokeAllSessions(userId, transaction) {
  await AdminUser.increment("tokenVersion", { where: { id: userId }, transaction });
  await AuthSession.update({ revokedAt: new Date() }, { where: { adminUserId: userId, revokedAt: null }, transaction });
}

