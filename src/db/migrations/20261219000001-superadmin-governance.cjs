"use strict";
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `
 CREATE TABLE permission_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(80) NOT NULL UNIQUE,
 base_role varchar(20) NOT NULL CHECK(base_role IN ('admin','support','partner')),
 permissions jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
 ALTER TABLE admin_users ADD COLUMN permission_role_id uuid REFERENCES permission_roles(id) ON DELETE RESTRICT;
 ALTER TABLE admin_users ADD COLUMN deleted_at timestamptz;
 CREATE TABLE impersonation_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES admin_users(id),
 target_id uuid NOT NULL REFERENCES admin_users(id), session_id uuid NOT NULL REFERENCES auth_sessions(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, reason varchar(500) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
 CREATE INDEX ix_impersonation_live ON impersonation_grants(actor_id,expires_at) WHERE revoked_at IS NULL;
 `,
        { transaction },
      );
    });
  },
  async down(q) {
    await q.sequelize.transaction(async (transaction) => {
      await q.sequelize.query(
        `DROP TABLE impersonation_grants;ALTER TABLE admin_users DROP COLUMN permission_role_id,DROP COLUMN deleted_at;DROP TABLE permission_roles;`,
        { transaction },
      );
    });
  },
};
