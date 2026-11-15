"use strict";
/** Upgrade installations that received the alternative TV-message schema without losing messages. */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      const [cols] = await q.sequelize.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tv_message_campaigns'",
        { transaction },
      );
      const names = new Set(cols.map((c) => c.column_name));
      for (const [before, after] of [
        ["sender_user_id", "sender_id"],
        ["sender_partner_id", "partner_id"],
        ["request_hash", "payload_hash"],
      ])
        if (names.has(before) && !names.has(after))
          await q.renameColumn("tv_message_campaigns", before, after, {
            transaction,
          });
      const [delivery] = await q.sequelize.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tv_message_deliveries'",
        { transaction },
      );
      if (delivery.some((c) => c.column_name === "id"))
        await q.sequelize.query(
          "ALTER TABLE tv_message_deliveries ALTER COLUMN id SET DEFAULT gen_random_uuid()",
          { transaction },
        );
    });
  },
  async down() {
    throw new Error("Forward-only: preserving TV-message history.");
  },
};
