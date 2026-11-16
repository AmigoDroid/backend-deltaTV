'use strict';
/** Non-destructive: preserve historical contracts, plans, stock and payment audit. */
module.exports={
 async up(q){await q.sequelize.transaction(async transaction=>{
  await q.sequelize.query(`CREATE TABLE IF NOT EXISTS partner_service_package_assignments (
    partner_id uuid PRIMARY KEY REFERENCES partners(id) ON DELETE RESTRICT,
    package_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
    package_snapshot jsonb NOT NULL,
    assigned_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS ix_service_package_assignment_code ON partner_service_package_assignments(package_code);
  `,{transaction});
 });},
 async down(){throw new Error('Migração aditiva sem rollback automático: preserve contratos legados e atribuições.');}
};
