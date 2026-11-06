import { Op } from "sequelize";
import { AdminUser, AuthSession } from "../db/models/index.js";
import { verifyJwt } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";

const PERMISSIONS = {
  superadmin: ["*"], // white-label:manage permanece exclusivo da administração principal
  admin: [
    "licenses:read", "licenses:write", "partners:read", "partners:write", "billing:read", "billing:write",
    "devices:read", "devices:write", "sources:read", "sources:write", "audit:read", "dashboard:read",
    "clients:read", "clients:write", "partner-users:manage", // fichas de clientes das revendas e usuários do portal (role partner)
    "web:read", "web:write", // acessos do Player Web (códigos AB123456) de todos os revendedores
    "downloads:read", "downloads:write", // links de download dos apps que os revendedores consultam
  ],
  support: [
    "licenses:read", "partners:read", "billing:read", "devices:read", "devices:write",
    "sources:read", "dashboard:read", "clients:read", "web:read", "downloads:read",
  ],
  partner: [], // parceiros só acessam /api/v1/partner (escopo próprio)
};

export const can = (role, perm) => {
  const list = PERMISSIONS[role] ?? [];
  return list.includes("*") || list.includes(perm);
};

export async function authenticate(req, _res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verifyJwt(token, "admin");
  const user = await AdminUser.findByPk(payload.sub);
  if (!user || user.status !== "active" || user.tokenVersion !== payload.tv) {
    throw new AppError(401, "INVALID_TOKEN", "Sessão inválida ou expirada.");
  }
  // A partir da etapa 7, todo access token possui sid: invalidar uma sessão
  // invalida também o JWT dela, sem desconectar as outras sessões.
  if (payload.sid) {
    const session = await AuthSession.findOne({ where: { id: payload.sid, adminUserId: user.id, revokedAt: null, expiresAt: { [Op.gt]: new Date() } }, attributes: ["id"] });
    if (!session) throw new AppError(401, "INVALID_TOKEN", "Sessão encerrada. Entre novamente.");
  }
  req.sessionId = payload.sid || null; // JWT anterior ao deploy permanece válido só até expirar.
  // Presença do portal: no máximo uma escrita por minuto por conta, compartilhada entre processos.
  // Falha de telemetria nunca deve derrubar uma requisição autenticada.
  if (user.role === "partner") {
    try {
      const cutoff = new Date(Date.now() - 60_000);
      await AdminUser.update({ lastActivityAt: new Date() }, { where: { id: user.id, [Op.or]: [{ lastActivityAt: null }, { lastActivityAt: { [Op.lt]: cutoff } }] } });
    } catch (error) { console.warn("[partner-presence]", error.message); }
  }
  req.user = { id: user.id, name: user.name, email: user.email, role: user.role, partnerId: user.partnerId };
  next();
}

export const requirePermission = (perm) => (req, _res, next) => {
  if (!req.user || !can(req.user.role, perm)) {
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
