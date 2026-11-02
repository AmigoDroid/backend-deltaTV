"use strict";
module.exports = {
  async up(q, S) {
    await q.addColumn("partner_notifications", "batch_id", { type: S.UUID, allowNull: true });
    await q.addIndex("partner_notifications", ["batch_id"], { name: "partner_notifications_batch_idx" });
  },
  async down(q) {
    await q.removeIndex("partner_notifications", "partner_notifications_batch_idx");
    await q.removeColumn("partner_notifications", "batch_id");
  },
};
