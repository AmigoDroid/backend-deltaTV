"use strict";
/** Etapa 1: registrar o preço e a cobertura financeira de novas emissões sem reescrever histórico legado. */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        ALTER TABLE reseller_master_issuance_requests
          ADD COLUMN IF NOT EXISTS unit_price_credits bigint,
          ADD COLUMN IF NOT EXISTS total_credits bigint,
          ADD COLUMN IF NOT EXISTS credit_balance_after bigint;
        COMMENT ON COLUMN reseller_master_issuance_requests.total_credits
          IS 'NULL para emissões legadas; novas emissões obrigatoriamente debitadas de credit_wallets';
      `, {transaction});
    });
  },
  async down() { throw new Error('Migração forward-only: não apagar registros financeiros de emissões.'); },
};
