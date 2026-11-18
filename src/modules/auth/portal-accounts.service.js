import { Op } from 'sequelize';
import { Partner } from '../../db/models/index.js';
import { PORTAL_AUDIENCES } from './role-context.js';

// Somente contas operacionais ativas da propria rede do Admin. Uma vinculacao
// legada explicita e aceita quando ainda nao tem titular comercial associado.
export function portalKinds(audience) {
  if (audience === 'content_partner') return ['content', 'both'];
  if (audience === 'partner') return ['reseller', 'both'];
  return [];
}

export function portalAccountFilter(admin, audience) {
  if (admin?.role !== 'admin' || !PORTAL_AUDIENCES.includes(audience)) return null;
  const owners = [{ ownerAdminId: admin.id }];
  if (admin.partnerId) owners.push({ id: admin.partnerId, ownerAdminId: null });
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

export async function defaultPortalAccount(admin, audience) {
  if (admin.partnerId) {
    const linked=await findPortalAccount(admin,audience,admin.partnerId);
    if(linked)return linked;
  }
  const where=portalAccountFilter(admin,audience);
  if(!where)return null;
  return Partner.findOne({where,attributes:['id','name','kind','status','ownerAdminId'],order:[['name','ASC'],['id','ASC']]});
}
