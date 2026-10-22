"use strict";
// Planos comerciais de licença individual (4, 6 e 12 meses). Idempotente.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO plans (code, name, duration_months, max_devices, price_cents) VALUES
        ('individual-4m',  'Individual 4 meses',  4,  1, 0),
        ('individual-6m',  'Individual 6 meses',  6,  1, 0),
        ('individual-12m', 'Individual 12 meses', 12, 1, 0)
      ON CONFLICT (code) DO NOTHING`);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `DELETE FROM plans WHERE code IN ('individual-4m','individual-6m','individual-12m')
         AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.plan_id = plans.id)`,
    );
  },
};
