'use strict';
/** Cobrança independente de plano e contrato, sem editar migrations aplicadas. */
module.exports={
  async up(q){
    await q.sequelize.transaction(async transaction=>{
      const run=sql=>q.sequelize.query(sql,{transaction});
      await run(`ALTER TABLE admin_network_charges DROP CONSTRAINT IF EXISTS admin_network_charges_kind_check;
        ALTER TABLE admin_network_charges ADD CONSTRAINT admin_network_charges_kind_check
          CHECK (kind IN ('renewal','upgrade','one_off'));
        ALTER TABLE admin_network_charges ALTER COLUMN plan_to DROP NOT NULL;
        ALTER TABLE admin_network_charges ADD CONSTRAINT network_charge_plan_to_check
          CHECK ((kind='one_off' AND plan_to IS NULL) OR (kind IN ('renewal','upgrade') AND plan_to IS NOT NULL));
        DROP INDEX IF EXISTS ux_network_charge_partner_open;
        CREATE UNIQUE INDEX ux_network_charge_partner_open ON admin_network_charges(partner_id)
          WHERE status IN ('creating','pending') AND kind IN ('renewal','upgrade');
        CREATE UNIQUE INDEX ux_network_charge_partner_one_off_open ON admin_network_charges(partner_id)
          WHERE status IN ('creating','pending') AND kind='one_off';`);
    });
  },
  async down(q){
    await q.sequelize.transaction(async transaction=>{
      const run=sql=>q.sequelize.query(sql,{transaction});
      const [rows]=await run(`SELECT count(*)::int AS n FROM admin_network_charges WHERE kind='one_off'`);
      if(Number(rows[0]?.n)>0)throw new Error('Rollback bloqueado: existem cobranças avulsas. Preserve o histórico financeiro.');
      const [duplicates]=await run(`SELECT partner_id FROM admin_network_charges WHERE status IN ('creating','pending')
        GROUP BY partner_id HAVING count(*)>1 LIMIT 1`);
      if(duplicates.length)throw new Error('Rollback bloqueado: há cobranças simultâneas de um mesmo parceiro.');
      await run(`DROP INDEX IF EXISTS ux_network_charge_partner_one_off_open;
        DROP INDEX IF EXISTS ux_network_charge_partner_open;
        CREATE UNIQUE INDEX ux_network_charge_partner_open ON admin_network_charges(partner_id)
          WHERE status IN ('creating','pending');
        ALTER TABLE admin_network_charges DROP CONSTRAINT IF EXISTS network_charge_plan_to_check;
        ALTER TABLE admin_network_charges ALTER COLUMN plan_to SET NOT NULL;
        ALTER TABLE admin_network_charges DROP CONSTRAINT IF EXISTS admin_network_charges_kind_check;
        ALTER TABLE admin_network_charges ADD CONSTRAINT admin_network_charges_kind_check
          CHECK (kind IN ('renewal','upgrade'));`);
    });
  },
};
