import { Op } from 'sequelize';
import { Partner, AdminUser, LoginHistory } from '../../db/models/index.js';
import { PORTAL_AUDIENCES } from './role-context.js';

// Os portais Parceiro/Revenda não oferecem administração de contas de terceiros.
// O Admin promovido só pode usar a conta operacional diretamente vinculada
// ao MESMO usuário (admin_users.partner_id). A rede continua sendo gerida no Admin.
export function portalKinds(audience) {
  if (audience === 'content_partner') return ['content', 'both'];
  if (audience === 'partner') return ['reseller', 'both'];
  return [];
}

export function portalAccountFilter(admin, audience) {
  if (admin?.role !== 'admin' || !admin.partnerId || !PORTAL_AUDIENCES.includes(audience)) return null;
  return { id: admin.partnerId, status: 'active', kind: { [Op.in]: portalKinds(audience) } };
}

export async function listPortalAccounts(admin, audience, {page=1, q=''} = {}) {
  const where = portalAccountFilter(admin, audience);
  if (!where) return {rows:[],count:0,page};
  const search=String(q||'').trim().slice(0,100);
  if(search) where.name = { [Op.iLike]: `%${search.replace(/[%_\\]/g,'')}%` };
  const {rows,count}=await Partner.findAndCountAll({where,attributes:['id','name','kind','status','ownerAdminId'],
    order:[['name','ASC'],['id','ASC']],limit:50,offset:(page-1)*50,distinct:true});
  return {rows,count,page};
}

export async function findPortalAccount(admin, audience, partnerId, transaction) {
  // A rota legada /auth/portal-account/select não pode sobrescrever o ID do
  // vínculo original fornecendo outro partnerId no corpo da requisição.
  if (!partnerId || String(partnerId) !== String(admin?.partnerId)) return null;
  const where = portalAccountFilter(admin, audience);
  if (!where) return null;
  return Partner.findOne({ where,
    attributes: ['id','name','kind','status','ownerAdminId'], transaction });
}

// Reconcilia a parceria anterior a uma promoção de Parceiro para Admin.
// Um vínculo histórico UNÍVOCO do MESMO usuário é mais confiável do que uma
// associação equivocada a "Teste Parceiro" feita após a promoção. Nunca se
// adivinha pelo nome, e-mail, pela primeira conta da rede ou pelos DNS.
// Quando não há histórico inequívoco, não modifica admin_users.partner_id.
export async function restoreOriginalPortalAccount(admin, audience) {
  if (admin?.role !== 'admin' || !PORTAL_AUDIENCES.includes(audience)) return null;
  const previous = await LoginHistory.findAll({
    where: { adminUserId: admin.id, role: 'partner', outcome: 'success', partnerId: { [Op.ne]: null } },
    attributes: ['partnerId'],
    group: ['partnerId'],
    limit: 2,
    raw: true,
  });
  if (previous.length !== 1) return null;
  const original = await Partner.findOne({
    where: { id: previous[0].partnerId, status: 'active', kind: { [Op.in]: portalKinds(audience) } },
    attributes: ['id','name','kind','status','ownerAdminId'],
  });
  if (!original) return null;
  if (admin.partnerId === original.id) return original;

  // Compare-and-swap: não sobrescrever alterações simultâneas do Superadmin.
  const oldPartnerId = admin.partnerId ?? null;
  const [updated] = await AdminUser.update({ partnerId: original.id }, {
    where: { id: admin.id, role: 'admin', partnerId: oldPartnerId },
  });
  if (!updated) {
    const current = await AdminUser.findByPk(admin.id, { attributes: ['partnerId'] });
    if (current?.partnerId !== original.id) return null;
  }
  admin.partnerId = original.id;
  return original;
}

// O login abre SOMENTE a parceria vinculada ao proprio usuario.
// Sem vinculo, o portal nao oferece conta alternativa nem cadastro vazio.
export async function defaultPortalAccount(admin, audience) {
  if (!admin.partnerId) return null;
  return findPortalAccount(admin, audience, admin.partnerId);
}
