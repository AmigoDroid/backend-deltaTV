"use strict";
// Preserva IDs, leituras e datas dos registros existentes; não elimina colunas legadas.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      await q.createTable("notification_campaigns", {
        id: { type: S.UUID, primaryKey: true, allowNull: false },
        sender_id: { type: S.UUID, allowNull: true, references: { model: "admin_users", key: "id" }, onDelete: "SET NULL" },
        title: { type: S.STRING(140), allowNull: false },
        message: { type: S.TEXT, allowNull: false },
        severity: { type: S.STRING(16), allowNull: false, defaultValue: "info" },
        created_at: { type: S.DATE, allowNull: false, defaultValue: S.NOW },
        updated_at: { type: S.DATE, allowNull: false, defaultValue: S.NOW },
      }, { transaction });
      await q.addColumn("partner_notifications", "campaign_id", { type: S.UUID, allowNull: true }, { transaction });
      // Para lotes antigos, reutiliza batch_id; para entregas legadas, usa o próprio id como pai.
      await q.sequelize.query(`
        INSERT INTO notification_campaigns (id, sender_id, title, message, severity, created_at, updated_at)
        SELECT DISTINCT ON (COALESCE(batch_id, id)) COALESCE(batch_id, id), sender_id,
               title, message, severity, created_at, updated_at
        FROM partner_notifications
        ORDER BY COALESCE(batch_id, id), created_at ASC, id ASC
      `, { transaction });
      await q.sequelize.query(`UPDATE partner_notifications SET campaign_id = COALESCE(batch_id, id) WHERE campaign_id IS NULL`, { transaction });
      await q.changeColumn("partner_notifications", "campaign_id", {
        type: S.UUID, allowNull: false,
        references: { model: "notification_campaigns", key: "id" }, onUpdate: "CASCADE", onDelete: "CASCADE"
      }, { transaction });
      await q.removeColumn("partner_notifications", "title", { transaction });
      await q.removeColumn("partner_notifications", "message", { transaction });
      await q.removeColumn("partner_notifications", "severity", { transaction });
      await q.addIndex("partner_notifications", ["campaign_id", "partner_id"], { unique: true, name: "partner_notifications_campaign_partner_unique", transaction });
      await q.addIndex("notification_campaigns", ["created_at"], { name: "notification_campaigns_created_idx", transaction });
    });
  },
  async down(q) {
    await q.sequelize.transaction(async transaction => {
      // Restabelece a forma anterior sem apagar as entregas ou o estado de leitura.
      await q.addColumn("partner_notifications", "title", { type: q.sequelize.Sequelize.STRING(140), allowNull: true }, { transaction });
      await q.addColumn("partner_notifications", "message", { type: q.sequelize.Sequelize.TEXT, allowNull: true }, { transaction });
      await q.addColumn("partner_notifications", "severity", { type: q.sequelize.Sequelize.STRING(16), allowNull: true }, { transaction });
      await q.sequelize.query(`UPDATE partner_notifications n SET title = c.title, message = c.message, severity = c.severity FROM notification_campaigns c WHERE n.campaign_id = c.id`, { transaction });
      await q.removeIndex("partner_notifications", "partner_notifications_campaign_partner_unique", { transaction });
      await q.removeColumn("partner_notifications", "campaign_id", { transaction });
      await q.dropTable("notification_campaigns", { transaction });
    });
  }
};
