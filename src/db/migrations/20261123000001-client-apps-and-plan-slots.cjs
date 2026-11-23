'use strict';

module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      const ref = (model, nullable = false) => ({
        type: S.UUID, allowNull: nullable, references: { model, key: 'id' }, onDelete: nullable ? 'SET NULL' : 'RESTRICT',
      });
      const stamp = { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') };
      await q.createTable('client_apps', {
        id: { type: S.UUID, primaryKey: true, defaultValue: S.UUIDV4 },
        identifier: { type: S.STRING(64), allowNull: false, unique: true },
        name: { type: S.STRING(120), allowNull: false },
        platform: { type: S.STRING(20), allowNull: false, defaultValue: 'roku' },
        status: { type: S.STRING(20), allowNull: false, defaultValue: 'active' },
        claim_code_hash: { type: S.CHAR(64) },
        claim_code_expires_at: { type: S.DATE },
        created_by: ref('admin_users', true),
        created_at: stamp, updated_at: stamp,
      }, { transaction });
      await q.sequelize.query(`ALTER TABLE client_apps ADD CONSTRAINT client_apps_identifier_valid CHECK (
        identifier ~ '^[a-z0-9][a-z0-9._-]{1,63}$' AND identifier NOT IN ('roku', 'delta-tv-roku'))`, { transaction });
      await q.sequelize.query("ALTER TABLE client_apps ADD CONSTRAINT client_apps_platform CHECK (platform IN ('roku'))", { transaction });
      await q.sequelize.query("ALTER TABLE client_apps ADD CONSTRAINT client_apps_status CHECK (status IN ('active','suspended'))", { transaction });
      await q.createTable('partner_apps', {
        id: { type: S.UUID, primaryKey: true, defaultValue: S.UUIDV4 },
        client_app_id: { ...ref('client_apps'), unique: true },
        partner_id: ref('partners'),
        partner_code_id: ref('partner_codes'),
        status: { type: S.STRING(20), allowNull: false, defaultValue: 'active' },
        linked_at: stamp,
        created_at: stamp, updated_at: stamp,
      }, { transaction });
      await q.sequelize.query("ALTER TABLE partner_apps ADD CONSTRAINT partner_apps_status CHECK (status IN ('active','paused'))", { transaction });
      await q.addIndex('partner_apps', ['partner_id', 'status'], { name: 'ix_partner_apps_owner_status', transaction });
      await q.addColumn('devices', 'client_app_id', ref('client_apps', true), { transaction });
      await q.addIndex('devices', ['client_app_id'], { name: 'ix_devices_client_app_id', transaction });
      await q.addColumn('service_plan_catalogs', 'max_apps', { type: S.INTEGER, allowNull: false, defaultValue: 0 }, { transaction });
      await q.sequelize.query('ALTER TABLE service_plan_catalogs ADD CONSTRAINT service_plans_max_apps CHECK (max_apps BETWEEN 0 AND 50)', { transaction });
      await q.addColumn('partner_service_plans', 'max_apps_override', { type: S.INTEGER, allowNull: true }, { transaction });
      await q.sequelize.query('ALTER TABLE partner_service_plans ADD CONSTRAINT partner_plans_apps_override CHECK (max_apps_override IS NULL OR max_apps_override BETWEEN 0 AND 50)', { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      // Deliberately stop if a production account still owns an app: a rollback must never lose ownership silently.
      const [[{ count }]] = await q.sequelize.query('SELECT count(*)::integer AS count FROM partner_apps', { transaction });
      if (count > 0) throw new Error('Desvincule os aplicativos antes de reverter esta migração.');
      const [[{ devices }]] = await q.sequelize.query('SELECT count(*)::integer AS devices FROM devices WHERE client_app_id IS NOT NULL', { transaction });
      if (devices > 0) throw new Error('Existem TVs com aplicativo próprio; rollback cancelado.');
      await q.removeColumn('devices', 'client_app_id', { transaction });
      await q.dropTable('partner_apps', { transaction });
      await q.dropTable('client_apps', { transaction });
      await q.removeColumn('partner_service_plans', 'max_apps_override', { transaction });
      await q.removeColumn('service_plan_catalogs', 'max_apps', { transaction });
    });
  },
};
