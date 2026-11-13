"use strict";
/** Etapa 1: chave canônica para a ficha COMERCIAL, sem tocar em MACs legados.
 * A ficha ainda pode existir sem TV cadastrada. FK é opcional por projeto.
 */
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.addColumn('reseller_clients', 'device_id', {
      type: S.UUID, allowNull: true,
      references: { model: 'devices', key: 'id' },
      onDelete: 'SET NULL', onUpdate: 'CASCADE',
      }, { transaction });
    // DB pequeno: um índice de apoio; IDs dos clientes continuam intactos.
    await q.sequelize.query(`CREATE INDEX IF NOT EXISTS idx_delta_client_owner_device
      ON reseller_clients (partner_id, device_id) WHERE device_id IS NOT NULL`, { transaction });
    });
  },
  async down(q) {
    const [rows] = await q.sequelize.query('SELECT count(*)::int AS n FROM reseller_clients WHERE device_id IS NOT NULL');
    if (Number(rows[0]?.n || 0)) throw new Error('Rollback da identidade recusado: existem clientes vinculados. Restaure o backup ou desfaça os vínculos explicitamente.');
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query('DROP INDEX IF EXISTS idx_delta_client_owner_device', { transaction });
      await q.removeColumn('reseller_clients','device_id',{ transaction });
    });
  }
};
