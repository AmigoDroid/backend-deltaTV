import { Op } from 'sequelize';
import { Partner, AdminUser, LoginHistory } from '../../db/models/index.js';
import { PORTAL_AUDIENCES } from './role-context.js';

// Contas operacionais ativas da propria rede do Admin e a conta vinculada
// diretamente ao proprio login, mesmo que seja de uma rede ascendente.
export function portalKinds(audience) {
  if (audience === 'content_partner') return ['content', 'both'];
  if (audience === 'partner') return ['reseller', 'both'];
  return [];
}

export function portalAccountFilter(admin, audience) {
  if (admin?.role !== 'admin' || !PORTAL_AUDIENCES.includes(audience)) return null;
  const owners = [{ ownerAdminId: admin.id }];
  // O parceiro vinculado ao login ANTES da promoção continua acessível mesmo
  // quando a conta comercial pertence a uma rede ascendente. Isso não dá
  // acesso aos demais parceiros daquela rede: apenas ao ID explícito.
  if (admin.partnerId) owners.push({ id: admin.partnerId });
  return { status: 'active', kind: { [Op.in]: portalKinds(audience) }, [Op.or]: owners };
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
  if (!partnerId) return null;
  const where = portalAccountFilter(admin, audience);
  if (!where) return null;
  return Partner.findOne({ where: { ...where, id: partnerId },
    attributes: ['id','name','kind','status','ownerAdminId'], transaction });
}

// Recupera a ligação exata de uma conta promovida em versões antigas que
// zeravam admin_users.partner_id. Não tenta adivinhar pela coincidência de
// e-mail, pelo nome ou pela primeira conta da rede.
// A identidade anterior precisa constar de um login bem-sucedido do MESMO
// admin_user enquanto ele ainda tinha papel 'partner'.
export async function restoreOriginalPortalAccount(admin, audience) {
  if (admin?.role !== 'admin' || admin.partnerId || !PORTAL_AUDIENCES.includes(audience)) return null;
  const previous = await LoginHistory.findAll({
    where: { adminUserId: admin.id, role: 'partner', outcome: 'success', partnerId: { [Op.ne]: null } },
    attributes: ['partnerId'],
    group: ['partnerId'],
    limit: 2,
    raw: true,
  });
  // Ambiguidade significa que a DeltaTV precisa confirmar o vínculo. Nunca
  // selecionar uma parceria arbitrária para evitar mostrar dados errados.
  if (previous.length !== 1) return null;
  const original = await Partner.findOne({
    where: { id: previous[0].partnerId, status: 'active', kind: { [Op.in]: portalKinds(audience) } },
    attributes: ['id','name','kind','status','ownerAdminId'],
  });
  if (!original) return null;
  // Restaurar só o vínculo de identidade do usuário. Não criar nova parceria,
  // nem mudar owner_admin_id nem deslocar DNS, códigos ou clientes.
  const [updated] = await AdminUser.update({ partnerId: original.id }, {
    where: { id: admin.id, role: 'admin', partnerId: null },
  });
  if (!updated) {
    const current = await AdminUser.findByPk(admin.id, { attributes: ['partnerId'] });
    if (current?.partnerId !== original.id) return null;
  }
  admin.partnerId = original.id;
  return original;
}

// O login inicial abre SOMENTE a parceria originalmente vinculada. A opção
// de alternar outras contas da própria rede permanece uma escolha explícita
// do Admin, nunca um fallback automático que aparenta cadastro "zerado".
export async function defaultPortalAccount(admin, audience) {
  if (!admin.partnerId) return null;
  return findPortalAccount(admin, audience, admin.partnerId);
}
