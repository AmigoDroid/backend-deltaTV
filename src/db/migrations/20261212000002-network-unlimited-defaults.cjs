"use strict";
/** Elimina quotas de negócio predefinidas. NULL significa não limitado.
 * Não altera valores já configurados em contas ou convites existentes.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        ALTER TABLE reseller_network_policies
          ALTER COLUMN max_children DROP NOT NULL,
          ALTER COLUMN max_children DROP DEFAULT,
          ALTER COLUMN max_depth DROP NOT NULL,
          ALTER COLUMN max_depth DROP DEFAULT;
        ALTER TABLE reseller_network_policies
          DROP CONSTRAINT IF EXISTS reseller_network_policies_max_children_check,
          DROP CONSTRAINT IF EXISTS reseller_network_policies_max_depth_check;
        ALTER TABLE reseller_network_policies
          ADD CONSTRAINT ck_distribution_max_children CHECK(max_children IS NULL OR max_children >= 0),
          ADD CONSTRAINT ck_distribution_max_depth CHECK(max_depth IS NULL OR max_depth >= 1);

        ALTER TABLE reseller_network_invites
          ALTER COLUMN expires_at DROP NOT NULL,
          ALTER COLUMN max_uses DROP NOT NULL,
          ALTER COLUMN max_uses DROP DEFAULT;
        ALTER TABLE reseller_network_invites
          DROP CONSTRAINT IF EXISTS reseller_network_invites_max_uses_check,
          DROP CONSTRAINT IF EXISTS reseller_network_invites_uses_check;
        ALTER TABLE reseller_network_invites
          ADD CONSTRAINT ck_distribution_invite_max_uses CHECK(max_uses IS NULL OR max_uses >= 1),
          ADD CONSTRAINT ck_distribution_invite_uses CHECK(uses >= 0 AND (max_uses IS NULL OR uses <= max_uses));

        -- Remoção de tetos comerciais artificiais (continuam os limites técnicos do tipo INTEGER).
        ALTER TABLE reseller_network_resources
          DROP CONSTRAINT IF EXISTS reseller_network_resources_limit_value_check;
        ALTER TABLE reseller_network_resources
          ADD CONSTRAINT ck_distribution_resource_limit CHECK(limit_value IS NULL OR limit_value >= 0);
        ALTER TABLE reseller_network_prices
          DROP CONSTRAINT IF EXISTS reseller_network_prices_price_credits_check;
        ALTER TABLE reseller_network_prices
          ADD CONSTRAINT ck_distribution_price_positive CHECK(price_credits > 0);
        ALTER TABLE reseller_network_sales
          DROP CONSTRAINT IF EXISTS reseller_network_sales_quantity_check;
        ALTER TABLE reseller_network_sales
          ADD CONSTRAINT ck_distribution_sale_quantity_positive CHECK(quantity > 0);
      `, { transaction });
    });
  },
  async down() {
    throw new Error("Reversão automática bloqueada: limites nulos podem estar em uso. Faça uma migração reversa planejada.");
  },
};
