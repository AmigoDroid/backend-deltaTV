import {PERMISSIONS} from "../../middleware/authenticate.js";
import {loginContext, sessionContext, roleForContext, PORTAL_AUDIENCES} from "./role-context.js";
import { defaultPortalAccount, findPortalAccount, listPortalAccounts } from "./portal-accounts.service.js";
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

const publicUser = async (u, context = u.role === 'partner' ? 'partner' : 'admin', selectedPartnerId = undefined, transaction) => {
 const partnerId = context === 'partner' ? (selectedPartnerId ?? u.partnerId) : (context === 'admin' ? u.partnerId : null);
 const custom=u.permissionRoleId?await PermissionRole.findByPk(u.permissionRoleId,{transaction}):null;
 const effectiveRole = roleForContext(u.role, context, !!partnerId);
 if (!effectiveRole) throw new AppError(401, 'INVALID_TOKEN', 'Contexto de sessão inválido.');
 const permissions = effectiveRole === 'admin' ? normalizeNetworkPermissions(u.delegatedPermissions) :
   (effectiveRole === 'partner' && u.role === 'admin' ?
     (u.permissionRoleId ? (custom?.baseRole==='partner' ? custom.permissions : []) : PERMISSIONS.partner) :
     (u.permissionRoleId ? (custom?.baseRole===effectiveRole?custom.permissions:[]) : PERMISSIONS[effectiveRole]||[]));
 const linkedPartner = partnerId ? await Partner.findByPk(partnerId, {attributes:['id','kind','status'],transaction}) : null;
 return {id:u.id,name:u.name,email:u.email,role:effectiveRole,partnerId,
   portalAdmin:u.role==='admin' && context!=='admin', portalSelectionRequired:context==='portal_select',
   partnerKind:linkedPartner?.kind||null,permissionRoleId:effectiveRole==='partner' ? u.permissionRoleId : null,
   permissions,delegatedPermissions:effectiveRole==='admin'?permissions:[],networkLimits:effectiveRole==='admin'?normalizeNetworkLimits(u.networkLimits):{}};
};

async function issue(user, meta, transaction, audience = user.role === 'partner' ? 'partner' : 'admin', selectedPartnerId = null) {
  const context = sessionContext(audience, user.role, user.role === 'admin' && PORTAL_AUDIENCES.includes(audience) ? selectedPartnerId : undefined);
  const partnerId = context === 'partner' ? (user.role === 'admin' ? selectedPartnerId : user.partnerId) : null;
  if (!roleForContext(user.role, context, !!partnerId)) throw new AppError(401,'INVALID_CREDENTIALS','Conta não autorizada para este painel.');
  const refreshToken = randomToken(48);
  const session = await AuthSession.create({
      adminUserId: user.id,
      refreshHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + env.adminRefreshTtlDays * 86400000),
      ip: meta.ip,
      userAgent: (meta.userAgent || '').slice(0, 300),
      audience,
      portalPartnerId: user.role === 'admin' && PORTAL_AUDIENCES.includes(audience) ? selectedPartnerId : null,
  }, {transaction});
  return {
    accessToken: signJwt({typ:'admin',sub:user.id,tv:user.tokenVersion,sid:session.id,ctx:context},env.adminAccessTtl),
    refreshToken,expiresIn:env.adminAccessTtl,
    user: await publicUser(user, context, partnerId, transaction),
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
  // A senha e identidade sao as mesmas nos tres paineis. Para Admin, a
  // parceria operacional pertence a SUA rede e fica vinculada a ESTA sessao.
  const targetAudience = audience || (user.role === 'partner' ? 'partner' : 'admin');
  const selected = user.role === 'admin' && PORTAL_AUDIENCES.includes(targetAudience)
    ? await defaultPortalAccount(user, targetAudience) : null;
  const partner = user.role === 'admin' ? selected : (user.partnerId ? await Partner.findByPk(user.partnerId, {attributes:['id','kind','status']}) : null);
  const context = user.role === 'admin' && PORTAL_AUDIENCES.includes(targetAudience)
    ? (selected ? 'partner' : 'portal_select') : loginContext(user, targetAudience, partner?.kind);
  if (!context || (targetAudience !== 'admin' && user.role !== 'admin' && (!partner || partner.status !== 'active'))) {
    await audit({ actor, action: 'auth.login', entityType: 'admin_user', entityId: user.id, result: 'failure', metadata: { reason: 'wrong_audience', audience: targetAudience } });
    await recordLogin(user, meta, 'failure', 'wrong_audience');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
  }
  await user.update({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(), lastActivityAt: user.role === "partner" ? new Date() : user.lastActivityAt });
  const result = await issue(user, meta, undefined, targetAudience, selected?.id ?? null);
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
    const selected = user.role === 'admin' && PORTAL_AUDIENCES.includes(audience) && session.portalPartnerId
      ? await findPortalAccount(user, audience, session.portalPartnerId, t) : null;
    const partner = user.role === 'admin' ? selected : (user.partnerId ? await Partner.findByPk(user.partnerId, {transaction:t,attributes:['id','kind','status']}) : null);
    if ((user.role === 'admin' && PORTAL_AUDIENCES.includes(audience) && session.portalPartnerId && !selected) ||
        (user.role !== 'admin' && (!loginContext(user, audience, partner?.kind) || (audience !== 'admin' && partner?.status !== 'active'))))
      throw new AppError(401, 'INVALID_TOKEN', 'Acesso a este painel foi revogado.');
    return issue(user, meta, t, audience, selected?.id ?? null);
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


// Um Admin pode consultar e trocar a conta operacional sem compartilhar senha
// ou obter acesso a qualquer conta de outra rede.
export async function portalAccounts(adminId, sessionId, {q, page=1} = {}) {
  const [user, session] = await Promise.all([
    AdminUser.findByPk(adminId),
    AuthSession.findOne({where:{id:sessionId,adminUserId:adminId,revokedAt:null,expiresAt:{[Op.gt]:new Date()}}}),
  ]);
  if (!user || user.role !== 'admin' || !session || !PORTAL_AUDIENCES.includes(session.audience))
    throw new AppError(403,'PORTAL_ADMIN_ONLY','Disponível apenas para o Admin da rede neste portal.');
  const {rows,count} = await listPortalAccounts(user, session.audience, {q,page});
  const selected = session.portalPartnerId ? await findPortalAccount(user,session.audience,session.portalPartnerId) : null;
  return {data:rows.map(p=>({id:p.id,name:p.name,kind:p.kind})),
    selectedPartner: selected ? {id:selected.id,name:selected.name,kind:selected.kind} : null,
    selectedPartnerId:session.portalPartnerId,meta:{page,pageSize:50,total:count,totalPages:Math.ceil(count/50)}};
}

export async function switchPortalAccount(adminId, sessionId, partnerId, meta) {
  return sequelize.transaction(async transaction=>{
    const session = await AuthSession.findOne({where:{id:sessionId,adminUserId:adminId,revokedAt:null,expiresAt:{[Op.gt]:new Date()}},transaction,lock:transaction.LOCK.UPDATE});
    const user = await AdminUser.findByPk(adminId,{transaction});
    if (!user || user.role !== 'admin' || user.status !== 'active' || user.deletedAt ||
        !session || !PORTAL_AUDIENCES.includes(session.audience))
      throw new AppError(403,'PORTAL_ADMIN_ONLY','Sessão de portal não autorizada.');
    const account = await findPortalAccount(user,session.audience,partnerId,transaction);
    if (!account) throw new AppError(403,'PORTAL_ACCOUNT_DENIED','Conta fora da sua rede, inativa ou incompatível com este portal.');
    const result = await issue(user,meta,transaction,session.audience,account.id);
    await session.update({revokedAt:new Date()},{transaction});
    return result;
  });
}
