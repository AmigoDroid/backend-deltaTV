"use strict";
module.exports = {
  async up(q) {
    await q.sequelize.query(
      "ALTER TABLE licenses ADD COLUMN max_sessions_per_activation integer CHECK(max_sessions_per_activation BETWEEN 1 AND 20)",
    );
  },
  async down(q) {
    await q.removeColumn("licenses", "max_sessions_per_activation");
  },
};
