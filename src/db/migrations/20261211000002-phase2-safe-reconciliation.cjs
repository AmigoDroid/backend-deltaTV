"use strict";
/** Etapa 2: vincula somente clientes cujos MACs correspondem a ativação
 * DO MESMO PARCEIRO e ao MAC do registro canônico do dispositivo.
 * Jamais funde registros e jamais assume que mesmo nome/telefone significa mesmo cliente.
 */
const MATCH = `SELECT c.id AS client_id, MIN(a.device_id::text)::uuid AS device_id
  FROM reseller_clients c
  JOIN activations a ON a.partner_id = c.partner_id AND a.mac = c.mac AND a.status <> 'revoked'
  JOIN devices d ON d.id = a.device_id AND d.mac = c.mac
  WHERE c.device_id IS NULL
  GROUP BY c.id
  HAVING count(DISTINCT a.device_id) = 1`;
module.exports = {
  async up(q) {
    await q.sequelize.query(`UPDATE reseller_clients c SET device_id = x.device_id
      FROM (${MATCH}) x WHERE c.id = x.client_id AND c.device_id IS NULL`);
    // View puramente diagnóstica: não contém PII, não grava linhas.
    await q.sequelize.query(`CREATE OR REPLACE VIEW v_delta_client_link_issues AS
      SELECT c.id AS client_id, c.partner_id, c.device_id,
             CASE WHEN c.device_id IS NOT NULL AND (d.id IS NULL OR d.mac <> c.mac) THEN 'identity_mismatch'
                  WHEN c.device_id IS NULL AND EXISTS
                       (SELECT 1 FROM activations a WHERE a.partner_id=c.partner_id AND a.mac=c.mac AND a.status <> 'revoked') THEN 'requires_reconciliation'
                  ELSE 'no_active_activation' END AS reason
      FROM reseller_clients c LEFT JOIN devices d ON d.id=c.device_id
      WHERE c.device_id IS NULL OR d.id IS NULL OR d.mac <> c.mac`);
  },
  async down(q) {
    await q.sequelize.query('DROP VIEW IF EXISTS v_delta_client_link_issues');
    // NÃO apaga vínculos; o backfill é rastreável pelos IDs existentes e pode ser reaplicado.
  },
};
