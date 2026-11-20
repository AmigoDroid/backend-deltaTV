'use strict';
/** Keeps an uncertain provider charge reserved until human review is completed.
 * Never silently permits a second Pix for a partner while payment may exist.
 */
module.exports={
  async up(q){await q.sequelize.transaction(async transaction=>{
    await q.sequelize.query(`DO $$ BEGIN
      IF EXISTS (
        SELECT partner_id FROM admin_network_charges
        WHERE status IN ('creating','pending','needs_review')
        GROUP BY partner_id HAVING count(*)>1
      ) THEN
        RAISE EXCEPTION 'network_charge_conflicting_reviews: reconcile existing open charges before this migration';
      END IF;
    END $$;
    DROP INDEX IF EXISTS ux_network_charge_partner_open;
    CREATE UNIQUE INDEX ux_network_charge_partner_open ON admin_network_charges(partner_id)
      WHERE status IN ('creating','pending','needs_review');`,{transaction});
  });},
  async down(q){await q.sequelize.transaction(async transaction=>{
    await q.sequelize.query(`DROP INDEX IF EXISTS ux_network_charge_partner_open;
      CREATE UNIQUE INDEX ux_network_charge_partner_open ON admin_network_charges(partner_id)
        WHERE status IN ('creating','pending');`,{transaction});
  });},
};
