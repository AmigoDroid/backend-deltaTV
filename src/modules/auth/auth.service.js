import {PERMISSIONS} from "../../middleware/authenticate.js";
import {loginContext, sessionContext, roleForContext} from "./role-context.js";
import {normalizeNetworkPermissions, normalizeNetworkLimits} from "../admin-workspaces/permissions.js";
import { disconnectAdminUser } from "../../realtime/socket.js";
import { recordLogin } from "./login-history.service.js";
import { Op } from "sequelize";
import { sequelize, AdminUser, AuthSession, Partner, PermissionRole } from "../../db/models/index.js";
import { env } from "../../config/env.js";
import { AppError } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { hashPassword, verifyPassword, signJwt, randomToken, sha256 } from "../../shared/crypto.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
let dummyHash;

const publicUser = async (u, context = u.role === "partner" ? "partner" : "admin") => {
 const custom=u.permissionRoleId?await PermissionRole.findByPk(u.permissionRoleId):null;
 const effectiveRole = roleForContext(u.role, context, !!u.partnerId);
 if (!effectiveRole) throw new AppError(401, 'INVALID_TOKEN', 'Contexto de sessão inválido.');
 const permissions = effectiveRole === "admin" ? normalizeNetworkPermissions(u.delegatedPermissions) :
   (effectiveRole === "partner" && u.role === "admin" ?
     (u.permissionRoleId ? (custom?.baseRole==='partner' ? custom.permissions : []) : PERMISSIONS.partner) :
     (u.permissionRoleId ? (custom?.baseRole===effectiveRole?custom.permissions:[]) : PERMISSIONS[effectiveRole]||[]));
 const linkedPartner = u.partnerId ? await Partner.findByPk(u.partnerId, {attributes:['id','kind','status']}) : null;
 return {id:u.id,name:u.name,email:u.email,role:effectiveRole,partnerId:context==='partner'||effectiveRole==='admin'?u.partnerId:null,
   partnerKind:linkedPartner?.kind||null,permissionRoleId:effectiveRole==='partner' ? u.permissionRoleId : null,
   permissions,delegatedPermissions:effectiveRole==="admin"?permissions:[],networkLimits:effectiveRole==="admin"?normalizeNetworkLimits(u.networkLimits):{}};
};

async function issue(user, meta, transaction, audience = user.role === "partner" ? "partner" : "admin") {
  const context = sessionContext(audience, user.role);
  if (!roleForContext(user.role, context, !!user.partnerId)) throw new AppError(401,"INVALID_CREDENTIALS","Conta não autorizada para este painel.");
  const refreshToken = randomToken(48);
  const session = await AuthSession.create(
    {
      adminUserId: user.id,
      refreshHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.adminRefreshTtlDays * 86400000),
      ip: meta.ip,
      userAgent: (meta.userAgent || "").slice(0, 300),
      audience,
    },
    { transaction },
  );
  return {
    accessToken: signJwt({ typ: "admin", sub: user.id, tv: user.tokenVersion, sid: session.id, ctx: context }, env.adminAccessTtl),
    refreshToken,
    expiresIn: env.adminAccessTtl,
    user: await publicUser(user, context),
  };
}

export async function login({ email, password, audience }, meta) {
  const user = await AdminUser.findOne({
    where: sequelize.where(sequelize.fn("lower", sequelize.col("email")), email.toLowerCase()),
  });
  const actor = { type: "anonymous", id: user?.id ?? null, ip: meta.ip };

  if (!user || user.status !== "active" || user.deletedAt) {
    dummyHash ??= await hashPassword("dummy-password-for-timing");
    await verifyPassword(password, dummyHash); // iguala o tempo de resposta
    await audit({ actor, action: "auth.login", entityType: "admin_user", result: "failure", metadata: { reason: "unknown_or_disabled" } });
    await recordLogin(user, meta, "failure", "invalid_credentials");
    throw new AppError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ actor, action: "auth.login", entityType: "admin_user", entityId: user.id, result: "failure", metadata: { reason: "locked" } });
    await recordLogin(user, meta, "failure", "locked");
    throw new AppError(429, "ACCOUNT_LOCKED", "Conta temporariamente bloqueada por tentativas inválidas.");
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLogins + 1;
    const lock = failed >= MAX_FAILED;
    await user.update({ failedLogins: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60000) : null });
    await audit({ actor, action: "auth.login", entityType: "admin_user", entityId: user.id, result: "failure", metadata: { reason: "bad_password", locked: lock } });
    await recordLogin(user, meta, "failure", lock ? "locked_after_failures" : "bad_password");
    throw new AppError(401, "INVALID_CREDENTIALS", "E-mail ou senha inválidos.");
  }
  // A identidade administrativa nunca é enviada aos portais operacionais.
  // A identidade operacional do Admin requer um parceiro vinculado e o contexto
  // é preso à sessão no banco, inclusive durante renovação de tokens.
  const targetAudience = audience || (user.role === 'partner' ? 'partner' : 'admin');
  const partner = user.partnerId ? await Partner.findByPk(user.partnerId, {attributes:['id','kind','status']}) : null;
  const context = loginContext(user, targetAudience, partner?.kind);
  if (!context || (targetAudience !== 'admin' && (!partner || partner.status !== 'active'))) {
    await audit({ actor, action: 'auth.login', entityType: 'admin_user', entityId: user.id, result: 'failure', metadata: { reason: 'wrong_audience', audience: targetAudience } });
    await recordLogin(user, meta, 'failure', 'wrong_audience');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
  }
  await user.update({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastActivityAt: user.role === "partner" ? new Date() : user.lastActivityAt });
  const result = await issue(user, meta, undefined, targetAudience);
  await recordLogin(user, meta, "success");
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
    if (!user || user.status !== "active" || user.deletedAt) throw new AppError(401, "INVALID_TOKEN", "Sessão inválida ou expirada.");
    await session.update({ revokedAt: new Date() }, { transaction: t });
    const audience = session.audience === 'legacy' ? (user.role === 'partner' ? 'partner' : 'admin') : session.audience;
    const partner = user.partnerId ? await Partner.findByPk(user.partnerId, {transaction:t,attributes:['id','kind','status']}) : null;
    if (!loginContext(user, audience, partner?.kind) || (audience !== 'admin' && partner?.status !== 'active'))
      throw new AppError(401, 'INVALID_TOKEN', 'Acesso a este painel foi revogado.');
    return issue(user, meta, t, audience);
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
  if (!transaction) disconnectAdminUser(userId); // transações devem fechar sockets após commit
}

