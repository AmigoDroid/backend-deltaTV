import { AdminUser } from "../db/models/index.js";
import { verifyJwt } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";

const PERMISSIONS = {
  superadmin: ["*"],
  admin: [
    "licenses:read", "licenses:write", "partners:read", "partners:write", "billing:read", "billing:write",
    "devices:read", "devices:write", "sources:read", "sources:write", "audit:read", "dashboard:read",
  ],
  support: [
    "licenses:read", "partners:read", "billing:read", "devices:read", "devices:write",
    "sources:read", "dashboard:read",
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
