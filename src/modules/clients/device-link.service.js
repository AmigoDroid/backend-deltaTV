/** Link opcional para a identidade canônica. O vínculo comercial é por parceiro,
 * e a confirmação do dispositivo exige que os MACs e o parceiro coincidam.
 * Quando não é possível provar, retorna null; nunca escolhe arbitrariamente.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../db/sequelize.js';

export async function resolveCommercialDeviceId(partnerId, mac, { transaction } = {}) {
  if (!partnerId || !mac) return null;
  const rows = await sequelize.query(`
    SELECT MIN(a.device_id::text)::uuid AS device_id
    FROM activations a
    JOIN devices d ON d.id=a.device_id AND d.mac=a.mac
    WHERE a.partner_id=:partnerId AND a.mac=:mac AND a.status <> 'revoked'
    HAVING count(DISTINCT a.device_id)=1`, {
      type: QueryTypes.SELECT, replacements: { partnerId, mac }, transaction,
    });
  return rows[0]?.device_id || null;
}
