"use strict";
// Permite que o mesmo usuário Admin mantenha sua conta operacional de Parceiro/Revenda.
// Não reassocia contas automaticamente, nem concede permissões.
module.exports = {
  async up(q, S) {
    await q.sequelize.transaction(async transaction => {
      // Constraint inicial era CHECK ((role='partner')=(partner_id IS NOT NULL)).
      // Obtém o nome real, mesmo em bancos que renomearam a constraint.
      await q.sequelize.query(`DO $$ DECLARE r record; BEGIN
        FOR r IN SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = 'admin_users'::regclass AND contype = 'c'
        LOOP
          IF r.definition ILIKE '%partner_id%' AND r.definition ILIKE '%role%'
            AND r.conname <> 'ck_admin_user_portal_link' THEN
            EXECUTE format('ALTER TABLE admin_users DROP CONSTRAINT %I', r.conname);
          END IF;
        END LOOP;
      END $$`, { transaction });
      await q.sequelize.query(`ALTER TABLE admin_users ADD CONSTRAINT ck_admin_user_portal_link CHECK (
         (role='partner' AND partner_id IS NOT NULL)
         OR role='admin'
         OR (role IN ('superadmin','support') AND partner_id IS NULL)
      )`, { transaction });
      await q.addColumn('auth_sessions','audience',{
        type:S.STRING(20),allowNull:false,defaultValue:'legacy'
      },{transaction});
      await q.sequelize.query(`ALTER TABLE auth_sessions ADD CONSTRAINT ck_auth_session_audience CHECK (
        audience IN ('legacy','admin','partner','content_partner')
      )`,{transaction});
    });
  },
  async down() { throw new Error('Reversão exige separar previamente as contas Admin com parceiro vinculado e encerrar sessões.'); }
};
