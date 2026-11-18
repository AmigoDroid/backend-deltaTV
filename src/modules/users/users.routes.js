import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { sequelize, AdminUser, Partner, ServicePlanCatalog, LoginHistory } from "../../db/models/index.js";
import { validate } from "../../shared/validate.js";
import { pageQuery, pageOf, paged } from "../../shared/pagination.js";
import { AppError, notFound } from "../../shared/errors.js";
import { actorOf, audit } from "../../shared/audit.js";
import { hashPassword } from "../../shared/crypto.js";
import { can } from "../../middleware/authenticate.js";
import { NETWORK_PERMISSIONS, normalizeNetworkPermissions, normalizeNetworkLimits } from "../admin-workspaces/permissions.js";
import { revokeAllSessions } from "../auth/auth.service.js";
import { disconnectAdminUser } from "../../realtime/socket.js";
import { sendPasswordResetToUser } from "../auth/password-reset.service.js";
import { passwordResetSendLimiter } from "../../middleware/security.js";

/**
 * Gestão de usuários.
 *  - superadmin ("users:manage"): todos os usuários e todas as funções.
 *  - admin ("partner-users:manage"): só usuários do PORTAL de revendas/parceiros (role "partner"): cria, edita e redefine senha,
 *    mas não enxerga nem promove contas da equipe (isso evitaria um admin criar um superadmin).
 */
const router = Router();
const id = z.object({ id: z.string().uuid() });
const safe = (u, partner) => { const j = u.toJSON(); delete j.passwordHash; delete j.passwordResetHash; delete j.passwordResetExpiresAt; delete j.passwordResetIssuedAt; return { ...j, partnerName: partner?.name ?? null }; };
const ROLES = ["superadmin", "admin", "support", "partner"];
const delegatedInput = z.array(z.enum(NETWORK_PERMISSIONS)).max(NETWORK_PERMISSIONS.length);
const networkLimitsInput = z.object({
  maxPartners: z.number().int().nonnegative().nullable().optional(),
  maxResellers: z.number().int().nonnegative().nullable().optional(),
  maxPlans: z.number().int().nonnegative().nullable().optional(),
  maxDnsPerCode: z.number().int().nonnegative().nullable().optional(),
  maxActivationsPerPartner: z.number().int().nonnegative().nullable().optional(),
}).strict();

router.use((req, _res, next) => {
  if (can(req.user, "users:manage")) req.userScope = "all";
  else if (can(req.user, "partner-users:manage")) req.userScope = "partner";
  else throw new AppError(403, "FORBIDDEN", "Você não tem permissão para esta operação.");
  next();
});

const partnerNames = async (users) => {
  const ids = [...new Set(users.map((u) => u.partnerId).filter(Boolean))];
  const list = ids.length ? await Partner.findAll({ where: { id: { [Op.in]: ids } }, attributes: ["id", "name"] }) : [];
  return Object.fromEntries(list.map((p) => [p.id, p]));
};
const present = async (u) => safe(u, u.partnerId ? await Partner.findByPk(u.partnerId, { attributes: ["id", "name"] }) : null);
const forbiddenRole = () => new AppError(403, "FORBIDDEN", "Seu perfil só gerencia usuários do portal de parceiros.");
// Somente a DeltaTV vincula uma conta operacional a um Admin. A transação
// move APENAS a parceria selecionada, não a rede global nem outros parceiros.
// Não reassocia automaticamente registros ao alterar uma função.
async function assignPortalAccountToAdmin(partnerId, adminId, transaction) {
  const partner = await Partner.findByPk(partnerId, {transaction,lock:transaction.LOCK.UPDATE});
  if(!partner || partner.status === 'deleted') throw new AppError(422,'INVALID_PARTNER','Conta do parceiro não encontrada.');
  if (partner.ownerAdminId && partner.ownerAdminId !== adminId)
    throw new AppError(409,'PARTNER_OWNED_BY_OTHER_ADMIN','A conta pertence à rede de outro Admin. A transferência exige um processo próprio.');
  const otherAdmin = await AdminUser.findOne({where:{role:'admin',partnerId,id:{[Op.ne]:adminId},deletedAt:null},transaction});
  if (otherAdmin) throw new AppError(409,'PARTNER_ALREADY_LINKED','Esta conta operacional já está vinculada a outro Admin.');
  if(partner.ownerAdminId !== adminId) await partner.update({ownerAdminId:adminId},{transaction});
}


router.get("/", validate({ query: z.object({
  ...pageQuery, q: z.string().trim().max(100).optional(), role: z.enum(ROLES).optional(),
  status: z.enum(["active", "disabled"]).optional(), partnerId: z.string().uuid().optional(),
}) }), async (req, res) => {
  const { q, role, status, partnerId } = req.valid.query;
  const where = { deletedAt: null };
  // Escopo "partner": filtrar por outra função não encontra nada (e nunca revela contas da equipe).
  if (req.userScope === "partner" && role && role !== "partner") return res.json(paged([], 0, req.valid.query));
  where.role = req.userScope === "partner" ? "partner" : role;
  if (!where.role) delete where.role;
  if (status) where.status = status;
  if (partnerId) where.partnerId = partnerId;
  if (q) { const like = `%${q.replace(/[%_\\]/g, "")}%`; where[Op.or] = [{ name: { [Op.iLike]: like } }, { email: { [Op.iLike]: like } }]; }
  const { rows, count } = await AdminUser.findAndCountAll({ where, order: [["createdAt", "DESC"]], ...pageOf(req.valid.query) });
  const names = await partnerNames(rows);
  res.json(paged(rows.map((u) => safe(u, names[u.partnerId])), count, req.valid.query));
});

router.post(
  "/", validate({ body: z.object({ name: z.string().min(2).max(160), email: z.string().email().max(200), password: z.string().min(12).max(128), role: z.enum(ROLES), partnerId: z.string().uuid().optional(), delegatedPermissions: delegatedInput.optional(), networkLimits: networkLimitsInput.optional() }) }),
  async (req, res) => {
    const b = req.valid.body;
    if (req.userScope === "partner" && b.role !== "partner") throw forbiddenRole();
    if ((b.delegatedPermissions?.length || b.networkLimits) && b.role !== "admin") throw new AppError(422,"INVALID_DELEGATION","Permissões de rede exigem usuário Admin.");
    if ((b.role === "partner" && !b.partnerId) || (!['partner','admin'].includes(b.role) && b.partnerId))
      throw new AppError(422, "PARTNER_REQUIRED", "Parceiro é obrigatório para usuário do portal e opcional para Admin.");
    if (b.partnerId && !(await Partner.findOne({ where: { id: b.partnerId, status: { [Op.ne]: "deleted" } } }))) throw new AppError(422, "INVALID_PARTNER", "Parceiro inexistente ou excluído.");
    const u = await sequelize.transaction(async transaction => {
      const u = await AdminUser.create({ name: b.name, email: b.email,
        passwordHash: await hashPassword(b.password), role: b.role,
        partnerId: b.partnerId ?? null,
        delegatedPermissions: b.role === "admin" ? normalizeNetworkPermissions(b.delegatedPermissions) : [],
        networkLimits: b.role === "admin" ? normalizeNetworkLimits(b.networkLimits) : {} },{transaction});
      if (b.role === 'admin' && b.partnerId) await assignPortalAccountToAdmin(b.partnerId, u.id, transaction);
      await audit({ actor: actorOf(req), action: "user.create", entityType: "admin_user", entityId: u.id,
        metadata: { role: b.role, partnerId: b.partnerId ?? null }, transaction });
      return u;
    });
    res.status(201).json(await present(u));
  },
);

// Recuperação assistida de contas já promovidas pela versão antiga, que limpava
// partner_id sem registrar um vínculo novo. Somente a DeltaTV consulta sugestões.
// Nenhum dado muda até a confirmação explícita do PATCH do usuário.
router.get('/:id/portal-link-options',validate({params:id}),async(req,res)=>{
  if(req.user.role !== 'superadmin')throw new AppError(403,'DELTATV_ONLY','Operação exclusiva da DeltaTV.');
  const u=await AdminUser.findByPk(req.valid.params.id);
  if(!u || u.deletedAt)throw notFound('Usuário');
  if(u.role !== 'admin')throw new AppError(409,'NOT_AN_ADMIN','Disponível apenas para Admins.');
  const history=await LoginHistory.findAll({where:{adminUserId:u.id,partnerId:{[Op.ne]:null}},
    attributes:['partnerId'],order:[['createdAt','DESC']],limit:30});
  const ids=[...new Set(history.map(entry=>entry.partnerId).filter(Boolean))];
  const [historical,byContact]=await Promise.all([
    ids.length ? Partner.findAll({where:{id:{[Op.in]:ids}},attributes:['id','name','kind','status','ownerAdminId']}) : [],
    Partner.findAll({where:{contactEmail:{[Op.iLike]:u.email}},attributes:['id','name','kind','status','ownerAdminId'],limit:10})
  ]);
  const result=[...new Map([...historical,...byContact]
    .filter(partner=>partner.status !== 'deleted' && (!partner.ownerAdminId || partner.ownerAdminId===u.id))
    .map(partner=>[partner.id,partner])).values()];
  res.set('Cache-Control','no-store').json({data:result.map(partner=>({id:partner.id,name:partner.name,kind:partner.kind}))});
});

// Não envia senha temporária nem devolve o link na API: somente o e-mail cadastrado recebe.
router.post("/:id/send-password-reset", passwordResetSendLimiter, validate({ params: id }), async (req, res) => {
  const target = await AdminUser.findByPk(req.valid.params.id, { attributes: ["id", "role", "status"] });
  if (!target) throw notFound("Usuário");
  if (req.userScope === "partner" && target.role !== "partner") throw forbiddenRole();
  res.set("Cache-Control", "no-store").status(202).json(await sendPasswordResetToUser(target.id, actorOf(req)));
});

router.patch(
  "/:id", validate({ params: id, body: z.object({
    name: z.string().min(2).max(160).optional(), email: z.string().email().max(200).optional(),
    status: z.enum(["active", "disabled"]).optional(), password: z.string().min(12).max(128).optional(),
    role: z.enum(ROLES).optional(), partnerId: z.string().uuid().nullable().optional(),
    delegatedPermissions: delegatedInput.optional(), networkLimits: networkLimitsInput.optional(),
  }).refine((b) => Object.keys(b).length > 0, "Nada para alterar.") }),
  async (req, res) => {
    const u = await sequelize.transaction(async transaction => {
    // Lock the complete set in a stable order before checking the final active superadmin.
    await AdminUser.findAll({ where: { role: "superadmin" }, order: [["id", "ASC"]], transaction, lock: transaction.LOCK.UPDATE });
    const u = await AdminUser.findByPk(req.valid.params.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!u || u.deletedAt) throw notFound("Usuário");
    if (req.userScope === "partner" && (u.role !== "partner" || (req.valid.body.role && req.valid.body.role !== "partner"))) throw forbiddenRole();
    if ((req.valid.body.delegatedPermissions || req.valid.body.networkLimits) && (req.user.role !== "superadmin" || (req.valid.body.role ?? u.role) !== "admin"))
      throw new AppError(403,"DELTATV_ONLY","Apenas a DeltaTV delega permissões de administração.");
    const { password, ...rest } = req.valid.body;
    const self = u.id === req.user.id;
    if (self && rest.status === "disabled") throw new AppError(409, "SELF_DISABLE", "Você não pode desativar a própria conta.");
    if (self && rest.role && rest.role !== u.role) throw new AppError(409, "SELF_ROLE", "Você não pode alterar a própria função.");

    // O Admin pode operar a própria conta de Parceiro/Revenda no mesmo login,
    // mas os tokens dos portais NUNCA carregam privilégios administrativos.
    const role = rest.role ?? u.role;
    // Promoção de Parceiro para Admin nunca substitui a parceria anterior por
    // um ID selecionado acidentalmente no formulário administrativo.
    if (u.role === 'partner' && role === 'admin' && rest.partnerId !== undefined && rest.partnerId !== u.partnerId)
      throw new AppError(422, 'ORIGINAL_PARTNER_MISMATCH',
        'A promoção deve preservar a parceria original. Altere o vínculo separadamente se realmente necessário.');
    const partnerId = rest.partnerId !== undefined ? rest.partnerId :
      (['partner','admin'].includes(role) ? u.partnerId : null);
    if ((role === 'partner' && !partnerId) || (!['partner','admin'].includes(role) && partnerId))
      throw new AppError(422,'PARTNER_REQUIRED','Parceiro obrigatório no portal e opcional para Admin.');
    if (partnerId && !(await Partner.findOne({ where: { id: partnerId, status: { [Op.ne]: "deleted" } },transaction })))
      throw new AppError(422, "INVALID_PARTNER", "Parceiro inexistente ou excluído.");
    // Ao promover o Parceiro existente, preservar sua parceria original sem
    // reatribuir a rede comercial ou recriar os dados operacionais. O vínculo
    // já foi provado pela própria conta que está sendo promovida.
    const preservingOriginal = u.role === 'partner' && role === 'admin' && partnerId === u.partnerId;
    if (role === 'admin' && partnerId && !preservingOriginal)
      await assignPortalAccountToAdmin(partnerId,u.id,transaction);
    if (u.role === 'admin' && role !== 'admin') {
      const [ownedPartners,ownedPlans]=await Promise.all([
        Partner.count({where:{ownerAdminId:u.id},transaction}),
        ServicePlanCatalog.count({where:{ownerAdminId:u.id},transaction})
      ]);
      if (ownedPartners || ownedPlans) throw new AppError(409,'ADMIN_NETWORK_REASSIGN_REQUIRED',
        'Este Admin possui parceiros ou planos. Reatribua a rede à DeltaTV antes de remover a função.');
    }
    const changes = { ...rest, role, partnerId,
      delegatedPermissions: role === "admin" ? normalizeNetworkPermissions(rest.delegatedPermissions ?? u.delegatedPermissions) : [],
      networkLimits: role === "admin" ? normalizeNetworkLimits(rest.networkLimits ?? u.networkLimits) : {},
      ...(role !== u.role && !(role === 'admin' && u.role === 'partner') ? {permissionRoleId:null} : {}) };

    // Nunca deixar a plataforma sem superadmin ativo.
    const losesSuper = u.role === "superadmin" && u.status === "active" && (role !== "superadmin" || changes.status === "disabled");
    if (losesSuper && (await AdminUser.count({ where: { role: "superadmin", status: "active", id: { [Op.ne]: u.id } }, transaction })) === 0) {
      throw new AppError(409, "LAST_SUPERADMIN", "É preciso manter ao menos um superadmin ativo.");
    }

    const permissionsChanged = JSON.stringify(changes.delegatedPermissions) !== JSON.stringify(normalizeNetworkPermissions(u.delegatedPermissions)) ||
      JSON.stringify(changes.networkLimits) !== JSON.stringify(normalizeNetworkLimits(u.networkLimits));
    const sensitive = !!password || permissionsChanged || changes.status === "disabled" || role !== u.role || partnerId !== u.partnerId || (changes.email && changes.email !== u.email);
    await u.update({ ...changes, ...(password ? { passwordHash: await hashPassword(password) } : {}),
      ...(sensitive ? { passwordResetHash: null, passwordResetExpiresAt: null, passwordResetIssuedAt: null } : {}) }, { transaction });
    if (sensitive) { await revokeAllSessions(u.id, transaction); transaction.afterCommit(() => disconnectAdminUser(u.id)); }
    await audit({ actor: actorOf(req), action: "user.update", entityType: "admin_user", entityId: u.id, metadata: { ...rest, partnerId, passwordChanged: !!password }, transaction });
    return u;
    });
    res.json(await present(u));
  },
);

export default router;
