/**
 * Foto exibida na listagem administrativa de parceiros/revendas.
 * O perfil pertence ao USUÁRIO do portal, não à empresa. Escolhemos a conta
 * ativa que possui foto e corresponde ao e-mail de contato da empresa; senão,
 * a conta ativa com foto criada primeiro (ordem estável).
 *
 * Somente metadados são buscados durante a listagem. As imagens grandes
 * são transmitidas separadamente e apenas sob autorização partners:read.
 */
import { Op, QueryTypes } from "sequelize";
import { sequelize, Partner, AdminUserProfile } from "../../db/models/index.js";

export function selectAvatarOwners(partners, candidates) {
  const byId = new Map(partners.map(p => [p.id, p]));
  const picked = new Map();
  for (const user of candidates) {
    const partner = byId.get(user.partnerId);
    if (!partner || !user.avatarUpdatedAt) continue;
    const match = Boolean(partner.contactEmail && user.email?.toLowerCase() === partner.contactEmail.toLowerCase());
    const previous = picked.get(partner.id);
    const time = new Date(user.createdAt).getTime();
    const prevTime = previous ? new Date(previous.createdAt).getTime() : Infinity;
    // Uma conta cujo e-mail coincide com o contato é prioritária;
    // fora disso, a mais antiga é a representante estável.
    if (!previous || (match && !previous.contactMatch) || (match === previous.contactMatch &&
      (time < prevTime || time === prevTime && user.userId < previous.userId))) {
      picked.set(partner.id, { ...user, contactMatch: match });
    }
  }
  return picked;
}

export function avatarVersion(owner) {
  return owner ? `${owner.userId}:${new Date(owner.avatarUpdatedAt).toISOString()}` : null;
}

export async function findAvatarOwners(partners) {
  if (!partners.length) return new Map();
  const ids = partners.map(p => p.id);
  // Consulta em lote: não executa N consultas para N linhas, não transfere BLOB
  // e não lê fotos de usuários desativados ou alheios ao cadastro.
  const candidates = await sequelize.query(`
    SELECT u.id AS "userId", u.partner_id AS "partnerId", u.email,
           u.created_at AS "createdAt", p.updated_at AS "avatarUpdatedAt"
    FROM admin_users u
    JOIN admin_user_profiles p ON p.admin_user_id = u.id
    WHERE u.partner_id IN (:partnerIds)
      AND u.role = 'partner' AND u.status = 'active'
      AND p.avatar_data IS NOT NULL
    ORDER BY u.created_at ASC, u.id ASC
  `, { replacements: { partnerIds: ids }, type: QueryTypes.SELECT });
  return selectAvatarOwners(partners, candidates);
}

export async function getPartnerAvatarImages(ids) {
  const partners = await Partner.findAll({
    where: { id: { [Op.in]: ids }, status: { [Op.ne]: "deleted" } },
    attributes: ["id", "contactEmail"], raw: true,
  });
  const owners = await findAvatarOwners(partners);
  if (!owners.size) return [];
  const profiles = await AdminUserProfile.findAll({
    where: { adminUserId: { [Op.in]: [...owners.values()].map(owner => owner.userId) } },
    attributes: ["adminUserId", "avatarData", "updatedAt"], raw: true,
  });
  const images = new Map(profiles.map(profile => [profile.adminUserId, profile]));
  return [...owners.entries()].flatMap(([partnerId, owner]) => {
    const profile = images.get(owner.userId);
    // Mesmo que a conta tenha sido atualizada entre as duas consultas, envie
    // a revisão real da imagem. O cliente confere a revisão da página.
    if (!profile?.avatarData || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(profile.avatarData)) return [];
    return [{ partnerId, avatarVersion: avatarVersion({ ...owner, avatarUpdatedAt: profile.updatedAt }), avatarData: profile.avatarData }];
  });
}
