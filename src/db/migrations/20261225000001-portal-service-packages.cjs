'use strict';
/** Commercial UI v2. Additive: no change to old stock, orders, contracts or device IDs. */
module.exports={
 async up(q){await q.sequelize.transaction(async t=>{const query=s=>q.sequelize.query(s,{transaction:t});
 await query(`
 ALTER TABLE partner_portal_sales_plans
   ADD COLUMN IF NOT EXISTS service_tier varchar(32) REFERENCES service_plan_catalogs(key) ON DELETE RESTRICT,
   ADD COLUMN IF NOT EXISTS max_dns integer CHECK(max_dns IS NULL OR max_dns >= 1),
   ADD COLUMN IF NOT EXISTS activation_limit integer CHECK(activation_limit IS NULL OR activation_limit >= 0),
   ADD COLUMN IF NOT EXISTS auto_failover boolean,
   ADD COLUMN IF NOT EXISTS auto_priority boolean,
   ADD COLUMN IF NOT EXISTS email_alerts boolean,
   ADD COLUMN IF NOT EXISTS detailed_history boolean,
   ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
 ALTER TABLE partner_portal_access_contracts ADD COLUMN IF NOT EXISTS package_snapshot jsonb;
 ALTER TABLE partner_portal_sales_invitations
   ADD COLUMN IF NOT EXISTS payment_gateway varchar(20) NOT NULL DEFAULT 'manual'
    CHECK(payment_gateway IN ('manual','mercadopago','infinitepay')),
   ADD COLUMN IF NOT EXISTS payment_status varchar(12) NOT NULL DEFAULT 'unpaid'
    CHECK(payment_status IN ('unpaid','paid')),
   ADD COLUMN IF NOT EXISTS payment_total_cents bigint,
   ADD COLUMN IF NOT EXISTS checkout_url text,
   ADD COLUMN IF NOT EXISTS payment_pix_code text,
   ADD COLUMN IF NOT EXISTS payment_expires_at timestamptz,
   ADD COLUMN IF NOT EXISTS payment_provider_ref varchar(160),
   ADD COLUMN IF NOT EXISTS payment_reference varchar(160) UNIQUE,
   ADD COLUMN IF NOT EXISTS payment_transaction_nsu varchar(160),
   ADD COLUMN IF NOT EXISTS payment_slug varchar(160),
   ADD COLUMN IF NOT EXISTS paid_at timestamptz;
 ALTER TABLE partner_portal_sales_invitations ADD COLUMN IF NOT EXISTS package_snapshot jsonb;
 ALTER TABLE partner_portal_sellers
   ADD COLUMN IF NOT EXISTS can_create_submasters boolean NOT NULL DEFAULT false,
   ADD COLUMN IF NOT EXISTS can_transfer_stock boolean NOT NULL DEFAULT true,
   ADD COLUMN IF NOT EXISTS can_view_finance boolean NOT NULL DEFAULT false,
   ADD COLUMN IF NOT EXISTS can_manage_gateways boolean NOT NULL DEFAULT false;
 -- Masters raiz anteriores preservam a possibilidade de emitir Submasters; descendentes só com autorização explícita.
 UPDATE partner_portal_sellers SET can_create_submasters=true,can_view_finance=true,can_manage_gateways=true
 WHERE parent_partner_id IS NULL;
 CREATE TABLE IF NOT EXISTS partner_portal_master_packages(
  partner_id uuid PRIMARY KEY REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
  plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
  package_snapshot jsonb NOT NULL,
  first_order_id uuid NOT NULL UNIQUE REFERENCES partner_portal_stock_orders(id) ON DELETE RESTRICT,
  monthly_fee_cents bigint NOT NULL DEFAULT 0 CHECK(monthly_fee_cents>=0),
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','pending_review')),
  activated_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS partner_portal_seller_prices(
  seller_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
  plan_code varchar(32) NOT NULL REFERENCES partner_portal_sales_plans(code) ON DELETE RESTRICT,
  unit_price_cents bigint NOT NULL CHECK(unit_price_cents>0),
  agreed_at timestamptz NOT NULL DEFAULT now(),
  agreed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  PRIMARY KEY(seller_partner_id,plan_code)
 );
 CREATE TABLE IF NOT EXISTS partner_portal_reparent_requests(
   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
   subject_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
   destination_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
   requested_by uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
   status varchar(16) NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
   created_at timestamptz NOT NULL DEFAULT now(),reviewed_at timestamptz,
   CHECK(subject_partner_id<>destination_partner_id)
 );
 CREATE UNIQUE INDEX IF NOT EXISTS ix_portal_reparent_pending ON partner_portal_reparent_requests(subject_partner_id)
   WHERE status='pending';
 CREATE INDEX IF NOT EXISTS ix_portal_reparent_destination ON partner_portal_reparent_requests(destination_partner_id,created_at DESC);
 CREATE TABLE IF NOT EXISTS partner_portal_reparent_codes(
  token_hash char(64) PRIMARY KEY,
  subject_partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),used_at timestamptz
 );
 CREATE INDEX IF NOT EXISTS ix_portal_reparent_codes_subject ON partner_portal_reparent_codes(subject_partner_id,expires_at DESC);
 CREATE TABLE IF NOT EXISTS partner_portal_seller_gateways(
   partner_id uuid NOT NULL REFERENCES partner_portal_sellers(partner_id) ON DELETE RESTRICT,
   provider varchar(20) NOT NULL CHECK(provider IN ('mercadopago','infinitepay')),
   credentials_enc text NOT NULL,
   account_ref varchar(160),
   active boolean NOT NULL DEFAULT true,
   created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
   PRIMARY KEY(partner_id,provider)
 );
 ALTER TABLE partner_portal_sellers ADD COLUMN IF NOT EXISTS default_gateway varchar(20)
  CHECK(default_gateway IN ('mercadopago','infinitepay'));
 -- Immutable number for both new and legacy content partners. Sequence is never reset.
 CREATE SEQUENCE IF NOT EXISTS public_partner_number_seq AS bigint START WITH 1000000000 INCREMENT BY 1 NO CYCLE;
 ALTER TABLE partners ADD COLUMN IF NOT EXISTS public_partner_number bigint;
 ALTER TABLE partners ALTER COLUMN public_partner_number SET DEFAULT nextval('public_partner_number_seq');
 UPDATE partners SET public_partner_number=nextval('public_partner_number_seq') WHERE public_partner_number IS NULL;
 SELECT setval('public_partner_number_seq', GREATEST((SELECT COALESCE(MAX(public_partner_number),1000000000) FROM partners), 1000000000), true);
 ALTER TABLE partners ALTER COLUMN public_partner_number SET NOT NULL;
 CREATE UNIQUE INDEX IF NOT EXISTS ux_partner_public_number ON partners(public_partner_number);
 CREATE OR REPLACE FUNCTION protect_public_partner_number() RETURNS trigger AS $$
 BEGIN IF NEW.public_partner_number IS DISTINCT FROM OLD.public_partner_number THEN
   RAISE EXCEPTION 'immutable public partner number' USING ERRCODE='23514'; END IF;
 RETURN NEW; END; $$ LANGUAGE plpgsql;
 DROP TRIGGER IF EXISTS trg_protect_public_partner_number ON partners;
 CREATE TRIGGER trg_protect_public_partner_number BEFORE UPDATE OF public_partner_number ON partners
 FOR EACH ROW EXECUTE FUNCTION protect_public_partner_number();
 CREATE TABLE IF NOT EXISTS partner_portal_support_tickets(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),protocol bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  creator_partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  assigned_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
  subject varchar(160) NOT NULL,category varchar(36) NOT NULL,
  priority varchar(12) NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent')),
  status varchar(24) NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS ix_portal_support_creator ON partner_portal_support_tickets(creator_partner_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS ix_portal_support_assigned ON partner_portal_support_tickets(assigned_partner_id,status,created_at DESC);
 CREATE TABLE IF NOT EXISTS partner_portal_support_messages(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),ticket_id uuid NOT NULL REFERENCES partner_portal_support_tickets(id) ON DELETE CASCADE,
  author_partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
  author_admin_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK(length(body) BETWEEN 1 AND 8000),
  internal boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS ix_portal_support_messages_ticket ON partner_portal_support_messages(ticket_id,created_at);
 `);
 });},
 async down(){throw new Error('Migração aditiva sem rollback automático: preserve histórico e contratos.');}
};
