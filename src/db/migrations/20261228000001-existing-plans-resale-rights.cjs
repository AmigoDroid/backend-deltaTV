"use strict";
// Use the ORIGINAL service_plan_catalogs as source-of-truth for selling portal access.
// The previous commercial catalogue is retained ONLY as a FK compatibility adapter.
module.exports = {
 async up(q) {
  await q.sequelize.transaction(async transaction => {
   const opt={transaction};
   await q.sequelize.query(`ALTER TABLE service_plan_catalogs
      ADD COLUMN IF NOT EXISTS can_resell_panel boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_create_submasters boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_view_finance boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS can_manage_gateways boolean NOT NULL DEFAULT false`,opt);
   // Grandfather sellers' existing rights on their already-assigned plans to avoid
   // blocking existing sales the moment this migration is applied.
   await q.sequelize.query(`UPDATE service_plan_catalogs c SET
      can_resell_panel=true,
      can_create_submasters=EXISTS(SELECT 1 FROM partner_portal_sellers s
        LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
        JOIN partners p ON p.id=s.partner_id
        WHERE COALESCE(sp.tier,CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=c.key AND s.active=true AND s.can_create_submasters=true),
      can_view_finance=EXISTS(SELECT 1 FROM partner_portal_sellers s
        LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
        JOIN partners p ON p.id=s.partner_id
        WHERE COALESCE(sp.tier,CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=c.key AND s.active=true AND s.can_view_finance=true),
      can_manage_gateways=EXISTS(SELECT 1 FROM partner_portal_sellers s
        LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
        JOIN partners p ON p.id=s.partner_id
        WHERE COALESCE(sp.tier,CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=c.key AND s.active=true AND s.can_manage_gateways=true)
     WHERE c.audience IN ('content','both') AND EXISTS (
       SELECT 1 FROM partner_portal_sellers s LEFT JOIN partner_service_plans sp ON sp.partner_id=s.partner_id
       JOIN partners p ON p.id=s.partner_id
       WHERE COALESCE(sp.tier,CASE WHEN p.kind='reseller' THEN 'reseller_basic' ELSE 'partner_professional' END)=c.key AND s.active=true AND s.can_sell=true)`,opt);
   // Legacy FKs point here. Prices for these internal adapter records must NOT
   // be interpreted as the price paid to DeltaTV; that lives in the original plan.
   await q.sequelize.query(`INSERT INTO partner_portal_sales_plans
     (code,name,wholesale_cents,min_resale_cents,active,service_tier,max_dns,activation_limit,
      auto_failover,auto_priority,email_alerts,detailed_history)
     SELECT key,name,1,1,active,key,max_servers,NULL,auto_failover,auto_priority,email_alerts,detailed_history
     FROM service_plan_catalogs WHERE audience IN ('content','both')
     ON CONFLICT(code) DO UPDATE SET name=excluded.name,wholesale_cents=1,min_resale_cents=1,service_tier=excluded.service_tier,
       max_dns=excluded.max_dns,auto_failover=excluded.auto_failover,auto_priority=excluded.auto_priority,
       email_alerts=excluded.email_alerts,detailed_history=excluded.detailed_history`,opt);
  });
 },
 async down(q){
  await q.sequelize.transaction(async transaction=>{
   // Never remove the legacy sales table: historical sales reference it.
   await q.sequelize.query(`ALTER TABLE service_plan_catalogs
    DROP COLUMN IF EXISTS can_resell_panel,
    DROP COLUMN IF EXISTS can_create_submasters,
    DROP COLUMN IF EXISTS can_view_finance,
    DROP COLUMN IF EXISTS can_manage_gateways`,{transaction});
  });
 }
};
