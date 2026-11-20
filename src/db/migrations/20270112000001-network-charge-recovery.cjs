'use strict';
/** Acrescenta estado de reconciliação sem mudar o snapshot ou a identidade financeira. */
module.exports={
  async up(q){
    await q.sequelize.transaction(async transaction=>{
      await q.sequelize.query(`ALTER TABLE admin_network_charges
        ADD COLUMN recovery_attempts smallint NOT NULL DEFAULT 0,
        ADD COLUMN recovery_checked_at timestamptz;
        CREATE INDEX ix_network_charge_stale_creating
        ON admin_network_charges(recovery_checked_at,updated_at)
        WHERE status='creating';`,{transaction});
    });
  },
  async down(q){
    await q.sequelize.transaction(async transaction=>{
      await q.sequelize.query(`DROP INDEX IF EXISTS ix_network_charge_stale_creating;
        ALTER TABLE admin_network_charges DROP COLUMN recovery_checked_at,
          DROP COLUMN recovery_attempts;`,{transaction});
    });
  },
};
