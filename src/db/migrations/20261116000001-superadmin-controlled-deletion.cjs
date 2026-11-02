"use strict";
// Mantém todos os documentos financeiros e a trilha de auditoria. Permite a remoção física
// de ativações sem apagar registros de cobrança de créditos que apontavam para elas.
module.exports = {
  async up(qi) {
    await qi.sequelize.transaction(async (transaction) => {
      await qi.sequelize.query(`ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_status_check;
        ALTER TABLE partners ADD CONSTRAINT partners_status_check
        CHECK (status IN ('active','suspended','blocked','cancelled','deleted'));`, { transaction });
      await qi.sequelize.query(`ALTER TABLE content_activation_charges ALTER COLUMN activation_id DROP NOT NULL;`, { transaction });
      await qi.sequelize.query(`ALTER TABLE content_activation_charges DROP CONSTRAINT IF EXISTS content_activation_charges_activation_id_fkey;`, { transaction });
      await qi.sequelize.query(`ALTER TABLE content_activation_charges ADD CONSTRAINT content_activation_charges_activation_id_fkey
        FOREIGN KEY (activation_id) REFERENCES activations(id) ON DELETE SET NULL;`, { transaction });
    });
  },
  async down() { throw new Error("Migração irreversível automaticamente: a remoção administrativa pode ter gerado registros históricos sem ativação."); },
};
