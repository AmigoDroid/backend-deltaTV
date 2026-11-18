'use strict';
// Seleciona a parceria operacional POR SESSAO. Nao altera admin_users.partner_id,
// nem permite que um Admin obtenha acesso a redes de terceiros.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.addColumn('auth_sessions', 'portal_partner_id', {type:S.UUID,allowNull:true}, {transaction});
      await q.addIndex('auth_sessions', ['portal_partner_id'], {name:'idx_auth_sessions_portal_partner',transaction});
      // Preserva logins operacionais validos da versao anterior.
      await q.sequelize.query(`UPDATE auth_sessions s SET portal_partner_id=u.partner_id
        FROM admin_users u JOIN partners p ON p.id=u.partner_id
        WHERE s.admin_user_id=u.id AND u.role='admin' AND s.audience IN ('partner','content_partner')
          AND p.status='active' AND
          (p.owner_admin_id=u.id OR p.owner_admin_id IS NULL) AND
          ((s.audience='partner' AND p.kind IN ('reseller','both'))
           OR (s.audience='content_partner' AND p.kind IN ('content','both')))` ,{transaction});
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      await q.removeIndex('auth_sessions', 'idx_auth_sessions_portal_partner', {transaction});
      await q.removeColumn('auth_sessions', 'portal_partner_id', {transaction});
    });
  },
};
