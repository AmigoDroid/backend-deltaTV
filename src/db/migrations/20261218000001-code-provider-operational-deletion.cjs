"use strict";
/** Exclusão operacional: histórico e FKs permanecem, mas o item deixa de ser usado/listado.
 * Nunca aplicar antes de resolver migrações anteriores pendentes.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(`
        ALTER TABLE partner_codes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
        ALTER TABLE partner_providers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
        CREATE INDEX IF NOT EXISTS ix_partner_codes_visible ON partner_codes(partner_id, created_at DESC) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS ix_partner_providers_visible ON partner_providers(partner_id, priority) WHERE deleted_at IS NULL;
        DROP INDEX IF EXISTS ux_partner_providers_url;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_providers_url ON partner_providers(partner_id, lower(base_url)) WHERE deleted_at IS NULL;
      `, {transaction});
    });
  },
  async down() {
    throw new Error("Reversão destrutiva bloqueada: exclusões operacionais devem ser preservadas; restaure pelo mecanismo específico.");
  },
};
