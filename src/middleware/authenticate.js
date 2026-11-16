import {sessionContext, roleForContext} from "../modules/auth/role-context.js";
import {governanceAudit} from "../modules/superadmin/governance-audit.js";
import {adminHasNetworkPermission, normalizeNetworkPermissions, normalizeNetworkLimits} from "../modules/admin-workspaces/permissions.js";
import { Op } from "sequelize";
import { AdminUser, AuthSession, PermissionRole, ImpersonationGrant, Partner } from "../db/models/index.js";
import { verifyJwt } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";

export const PERMISSIONS = {
  superadmin: ["*"], // white-label:manage permanece exclusivo da administração principal
  // Contas Admin usam permissões de rede explícitas, sempre isoladas.
  // As antigas permissões globais não são herdadas automaticamente.
  admin: [],
  support: [
    "licenses:read", "partners:read", "billing:read", "devices:read", "devices:write",
    "sources:read", "dashboard:read", "clients:read", "web:read", "downloads:read",
  ],
  partner: ["dashboard","messages","clients","licenses","devices","codes","providers","commerce","network","billing","pix","credits","web-access","help","notifications","downloads","white-label","support","monitor","account","stock","sources"].flatMap(area=>[`partner:${area}:read`,`partner:${area}:write`]), // namespaces isolated from admin
};

export const can = (user, perm) => {
 const role = typeof user === "string" ? user : user?.role;
 if (role === "superadmin") return true;
 // Impede que funções antigas de PermissionRole ampliem o acesso de Admins à DeltaTV.
 if (role === "admin") return typeof user === "object" && adminHasNetworkPermission(user, perm);
 const list = typeof user === "object" && Array.isArray(user.permissions) ? user.permissions : PERMISSIONS[role] ?? [];
 return list.includes(perm);
};

export async function resolveAdminClaims(payload) {
 const user = await AdminUser.findByPk(payload.sub);
 if (!user || user.status !== "active" || user.deletedAt || user.tokenVersion !== payload.tv) throw new AppError(401,"INVALID_TOKEN","Sessão inválida ou expirada.");
 let impersonator = null;
 if (payload.imp) {
  const grant = await ImpersonationGrant.findOne({where:{id:payload.imp,targetId:user.id,revokedAt:null,expiresAt:{[Op.gt]:new Date()}}});
  if(!grant || user.role !== "partner")throw new AppError(401,"INVALID_TOKEN","Impersonação encerrada.");
  const actor=await AdminUser.findByPk(grant.actorId);
  const session=await AuthSession.findOne({where:{id:grant.sessionId,adminUserId:grant.actorId,revokedAt:null,expiresAt:{[Op.gt]:new Date()}}});
  if(!actor||actor.role!=="superadmin"||actor.status!=="active"||actor.deletedAt||!session)throw new AppError(401,"INVALID_TOKEN","Sessão de origem encerrada.");
  const partner=await Partner.findByPk(user.partnerId);
  if(!partner||partner.status!=="active")throw new AppError(403,"FORBIDDEN","Parceria indisponível para impersonação.");
  impersonator={id:actor.id,name:actor.name,role:actor.role,grantId:grant.id};
 } else if(payload.sid) {
  const session=await AuthSession.findOne({where:{id:payload.sid,adminUserId:user.id,revokedAt:null,expiresAt:{[Op.gt]:new Date()}},attributes:["id","audience"]});
  if(!session)throw new AppError(401,"INVALID_TOKEN","Sessão encerrada. Entre novamente.");
  const expectedContext = sessionContext(session.audience, user.role);
  const actualContext = payload.ctx ?? (session.audience === 'legacy' ? expectedContext : null);
  if (!expectedContext || actualContext !== expectedContext)
    throw new AppError(401,"INVALID_TOKEN","Contexto da sessão inválido.");
  if (!roleForContext(user.role, actualContext, !!user.partnerId))
    throw new AppError(401,"INVALID_TOKEN","Permissão do portal revogada.");
  if (actualContext === 'partner') {
    const partner=await Partner.findByPk(user.partnerId,{attributes:['id','kind','status']});
    if(!partner || partner.status !== 'active' ||
       (session.audience === 'content_partner' && !['content','both'].includes(partner.kind)) ||
       (session.audience === 'partner' && user.role === 'admin' && !['reseller','both'].includes(partner.kind)))
      throw new AppError(401,"INVALID_TOKEN","Conta operacional indisponível.");
  }
  payload.resolvedContext=actualContext;
 } else if (!payload.imp) {
   // Tokens antigos sem uma sessão não ganham privilégio de portal nem de Admin.
   throw new AppError(401,"INVALID_TOKEN","Sessão não identificada.");
 }
 const context = payload.resolvedContext ?? (user.role==='partner' ? 'partner' : 'admin');
 const effectiveRole = roleForContext(user.role, context, !!user.partnerId);
 if(!effectiveRole)throw new AppError(401,'INVALID_TOKEN','Contexto inválido.');
 const custom=user.permissionRoleId && effectiveRole==='partner'?await PermissionRole.findByPk(user.permissionRoleId):null;
 const delegatedPermissions = effectiveRole === "admin" ? normalizeNetworkPermissions(user.delegatedPermissions) : [];
 const permissions = effectiveRole === "admin" ? delegatedPermissions :
   (effectiveRole === 'partner' && user.role === 'admin' ?
      (user.permissionRoleId ? (custom?.baseRole==='partner' ? custom.permissions : []) : PERMISSIONS.partner) :
      (user.permissionRoleId ? (custom?.baseRole===effectiveRole ? custom.permissions : []) : PERMISSIONS[effectiveRole] || []));
 return {user:{id:user.id,name:user.name,email:user.email,role:effectiveRole,partnerId:user.partnerId,
     permissionRoleId:effectiveRole==='partner'?user.permissionRoleId:null,permissions,delegatedPermissions,
     networkLimits:effectiveRole==="admin"?normalizeNetworkLimits(user.networkLimits):{}},impersonator,tokenVersion:user.tokenVersion};
}

export async function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verifyJwt(token, "admin");
  const resolved=await resolveAdminClaims(payload);
  const user=resolved.user;
  req.impersonator=resolved.impersonator;
  req.impersonationId=payload.imp || null;
  req.sessionId=payload.sid || null;
  // Presença do portal: no máximo uma escrita por minuto por conta, compartilhada entre processos.
  // Falha de telemetria nunca deve derrubar uma requisição autenticada.
  if (user.role === "partner") {
    try {
      const cutoff = new Date(Date.now() - 60_000);
      await AdminUser.update({ lastActivityAt: new Date() }, { where: { id: user.id, [Op.or]: [{ lastActivityAt: null }, { lastActivityAt: { [Op.lt]: cutoff } }] } });
    } catch (error) { console.warn("[partner-presence]", error.message); }
  }
  req.user = user;
  await governanceAudit(req,_res,next);
}

export const requirePermission = (perm) => (req, _res, next) => {
  if (!req.user || !can(req.user, perm)) {
    throw new AppError(403, "FORBIDDEN", "Você não tem permissão para esta operação.");
  }
  next();
};

// Rotas do portal do parceiro: o escopo vem SEMPRE do token, nunca de parâmetros da requisição.
export const requirePartnerRole = (req, _res, next) => {
  if (req.user?.role !== "partner" || !req.user.partnerId) {
    throw new AppError(403, "FORBIDDEN", "Acesso restrito a parceiros.");
  }
  next();
};

export function portalPermissionGate(req,_res,next){
 if(req.method==='GET'&&req.path==='/me')return next();
 const first=req.path.split('/').filter(Boolean)[0]||'dashboard';
 const aliases={'me':'dashboard','overview':'dashboard','summary':'dashboard','server-monitor':'monitor','servers':'providers','service-plan':'dashboard','commercial':'commerce','portal-sales':'network','credit-ledger':'credits','downloads':'downloads','app-downloads':'downloads','mac':'devices','license-activation':'licenses','payments':'billing','invoices':'billing','quality':'monitor'};
 const area=aliases[first]||first, action=['GET','HEAD','OPTIONS'].includes(req.method)?'read':'write';
 if(!can(req.user,`partner:${area}:${action}`))throw new AppError(403,'FORBIDDEN','Seu papel não permite esta ação no portal.');next();
}
