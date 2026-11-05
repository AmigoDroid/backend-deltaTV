"use strict";
module.exports = {
  async up(q, S) {
    const modes = { api: "redirect", live: "proxy", movie: "redirect", series: "redirect" };
    for (const part of String(process.env.WEB_DELIVERY_DEFAULTS || "").split(",")) {
      const [key, value] = part.split("=").map(s => s.trim());
      if (key in modes && ["proxy", "redirect"].includes(value)) modes[key] = value;
    }
    await q.sequelize.transaction(async transaction => {
      await q.createTable("platform_settings", { key: { type: S.STRING(80), primaryKey: true }, value: { type: S.JSONB, allowNull: false } }, { transaction });
      await q.bulkInsert("platform_settings", [{ key: "defaults", value: JSON.stringify({ trial: { enabled: true, days: 7 }, web: { autoHttps: true, deliveryModes: modes } }) }], { transaction });
      await q.addColumn("licenses", "is_trial", { type: S.BOOLEAN, allowNull: false, defaultValue: false }, { transaction });
      await q.createTable("device_trials", { mac: { type: S.STRING(17), primaryKey: true }, license_id: { type: S.UUID }, status: { type: S.STRING(30), allowNull: false }, starts_at: { type: S.DATE }, expires_at: { type: S.DATE } }, { transaction });
      await q.sequelize.query(`INSERT INTO device_trials(mac,status) SELECT mac,'existing' FROM devices WHERE mac IS NOT NULL ON CONFLICT DO NOTHING;
        INSERT INTO plans(id,code,name,duration_months,max_devices,price_cents,active,created_at,updated_at)
        VALUES(gen_random_uuid(),'AUTO_TRIAL','Teste gratuito automático',1,1,0,false,now(),now()) ON CONFLICT(code) DO NOTHING`, { transaction });
    });
  },
  async down(q) { await q.sequelize.transaction(async transaction => {
    await q.dropTable("device_trials", { transaction }); await q.dropTable("platform_settings", { transaction });
    await q.removeColumn("licenses", "is_trial", { transaction });
  }); },
};
