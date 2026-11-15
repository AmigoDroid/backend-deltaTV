"use strict";
/** Convites comerciais do PAINEL DO PARCEIRO (não convites para revendas de TV).
 * Toda conta convidada (inclusive Submaster) consome meses de acesso já pagos.
 * Migração aditiva e forward-only. Não altera contas ou contratos legados.
 */
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`
        CREATE TABLE partner_portal_sales_invitations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
          token_hash char(64) NOT NULL UNIQUE,
          invited_name varchar(160) NOT NULL,
          invited_email varchar(200) NOT NULL,
          invite_type varchar(12) NOT NULL CHECK (invite_type IN ('customer','submaster')),
          plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
          months int NOT NULL CHECK (months BETWEEN 1 AND 120),
          unit_resale_cents bigint NOT NULL CHECK (unit_resale_cents >= 0),
          monthly_fee_cents bigint NOT NULL DEFAULT 0 CHECK (monthly_fee_cents >= 0),
          status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
          created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
          accepted_partner_id uuid UNIQUE REFERENCES partners(id) ON DELETE RESTRICT,
          expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          accepted_at timestamptz,
          CHECK ((status = 'accepted') = (accepted_partner_id IS NOT NULL)),
          CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))
        );
        CREATE UNIQUE INDEX ux_portal_sales_pending_invite_email
          ON partner_portal_sales_invitations(lower(invited_email)) WHERE status='pending';
        CREATE INDEX ix_portal_sales_invites_seller
          ON partner_portal_sales_invitations(seller_partner_id,created_at DESC);
        CREATE INDEX ix_portal_sales_invites_expiry
          ON partner_portal_sales_invitations(expires_at) WHERE status='pending';
        COMMENT ON TABLE partner_portal_sales_invitations IS 'Convites de acesso pago ao Painel do Parceiro, com meses reservados do estoque do vendedor até aceite, expiração ou cancelamento.';
      `,{transaction});
    });
  },
  async down() { throw new Error('Migração forward-only: preserve reservas e histórico de convites comerciais.'); },
};
