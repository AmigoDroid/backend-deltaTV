'use strict';
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.addColumn('white_label_apps', 'appearance_enabled', {
        type: S.BOOLEAN, allowNull: false, defaultValue: false,
      }, { transaction });
      await q.createTable('white_label_app_appearances', {
        app_id: { type: S.UUID, primaryKey: true, allowNull: false,
          references: { model: 'white_label_apps', key: 'id' }, onDelete: 'CASCADE' },
        draft_config: { type: S.JSONB }, published_config: { type: S.JSONB },
        published_version: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
        published_at: { type: S.DATE },
        edited_by: { type: S.UUID, references: { model: 'admin_users', key: 'id' }, onDelete: 'SET NULL' },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      }, { transaction });
      await q.sequelize.query('ALTER TABLE white_label_app_appearances ADD CONSTRAINT ck_wl_appearance_version CHECK (published_version >= 0)', { transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      await q.dropTable('white_label_app_appearances', { transaction });
      await q.removeColumn('white_label_apps', 'appearance_enabled', { transaction });
    });
  },
};
