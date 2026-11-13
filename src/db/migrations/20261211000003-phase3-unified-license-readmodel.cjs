"use strict";
/** Etapa 3: leitura consolidada, SEM copiar estados de licença e SEM
 * substituir a política evaluateAccess/checkActivation, que continua a fonte de autorização.
 */
module.exports = {
  async up(q) {
    await q.sequelize.query(`CREATE OR REPLACE VIEW v_delta_device_current_activation AS
      SELECT DISTINCT ON (a.device_id)
        a.device_id, a.id AS activation_id, a.partner_id, a.license_id,
        a.granted_license_id, a.provider_id, a.status AS activation_status,
        a.activated_at
      FROM activations a WHERE a.status <> 'revoked'
      ORDER BY a.device_id, a.activated_at DESC, a.id DESC`);
    await q.sequelize.query(`CREATE OR REPLACE VIEW v_delta_device_license_inventory AS
      SELECT d.id AS device_id, d.mac, d.platform, d.last_seen_at,
             a.activation_id, a.activation_status, a.partner_id,
             a.license_id, a.granted_license_id, a.provider_id,
             l.status AS license_status, l.expires_at AS license_expires_at,
             gl.status AS granted_license_status, gl.expires_at AS granted_license_expires_at,
             p.status AS partner_status, p.ends_at AS partner_ends_at
      FROM devices d
      LEFT JOIN v_delta_device_current_activation a ON a.device_id=d.id
      LEFT JOIN licenses l ON l.id=a.license_id
      LEFT JOIN licenses gl ON gl.id=a.granted_license_id
      LEFT JOIN partners p ON p.id=a.partner_id`);
  },
  async down(q) {
    await q.sequelize.query('DROP VIEW IF EXISTS v_delta_device_license_inventory');
    await q.sequelize.query('DROP VIEW IF EXISTS v_delta_device_current_activation');
  },
};
