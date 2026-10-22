"use strict";
/**
 * Esquema inicial. Datas em timestamptz (UTC); valores monetários em centavos (integer).
 * Sem enums nativos (CHECK em texto) para facilitar evolução por migrations futuras.
 */
const TS = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;
const PK = `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`;

const UP = `
CREATE TABLE plans (
  ${PK},
  code varchar(40) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  duration_months int NOT NULL CHECK (duration_months IN (4, 6, 12)),
  max_devices int NOT NULL DEFAULT 1 CHECK (max_devices >= 1),
  price_cents int NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  ${TS}
);

CREATE TABLE partners (
  ${PK},
  name varchar(160) NOT NULL,
  slug varchar(60) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$'),
  contact_name varchar(160),
  contact_email varchar(200),
  contact_phone varchar(40),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','blocked','cancelled')),
  status_reason varchar(500),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  billing_model varchar(20) NOT NULL DEFAULT 'fixed' CHECK (billing_model IN ('fixed','per_device','tiered')),
  monthly_fee_cents int NOT NULL DEFAULT 0 CHECK (monthly_fee_cents >= 0),
  per_device_cents int NOT NULL DEFAULT 0 CHECK (per_device_cents >= 0),
  min_fee_cents int NOT NULL DEFAULT 0 CHECK (min_fee_cents >= 0),
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  device_limit int CHECK (device_limit IS NULL OR device_limit >= 0),
  due_day smallint NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 28),
  grace_days smallint NOT NULL DEFAULT 5 CHECK (grace_days >= 0),
  suspend_policy varchar(20) NOT NULL DEFAULT 'auto_after_grace' CHECK (suspend_policy IN ('auto_after_grace','manual')),
  notes text,
  ${TS},
  CHECK (ends_at > starts_at)
);
CREATE INDEX ix_partners_status ON partners (status);

CREATE TABLE admin_users (
  ${PK},
  name varchar(160) NOT NULL,
  email varchar(200) NOT NULL,
  password_hash text NOT NULL,
  role varchar(20) NOT NULL CHECK (role IN ('superadmin','admin','support','partner')),
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  token_version int NOT NULL DEFAULT 0,
  last_login_at timestamptz,
  ${TS},
  CHECK ((role = 'partner') = (partner_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_admin_users_email ON admin_users (lower(email));

CREATE TABLE auth_sessions (
  ${PK},
  admin_user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  refresh_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip varchar(64),
  user_agent varchar(300),
  ${TS}
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions (admin_user_id);

CREATE TABLE customers (
  ${PK},
  name varchar(160) NOT NULL,
  email varchar(200),
  phone varchar(40),
  notes text,
  ${TS}
);
CREATE INDEX ix_customers_email ON customers (lower(email));

CREATE TABLE licenses (
  ${PK},
  code_hash char(64) NOT NULL UNIQUE,
  code_last4 varchar(4) NOT NULL,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','suspended','blocked','cancelled')),
  status_reason varchar(500),
  starts_at timestamptz,
  expires_at timestamptz,
  max_devices int NOT NULL CHECK (max_devices >= 1),
  notes text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  ${TS},
  CHECK (status = 'pending' OR (starts_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX ix_licenses_status ON licenses (status);
CREATE INDEX ix_licenses_expires ON licenses (expires_at);
CREATE INDEX ix_licenses_customer ON licenses (customer_id);

CREATE TABLE partner_codes (
  ${PK},
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  code_hash char(64) NOT NULL UNIQUE,
  code_last4 varchar(4) NOT NULL,
  label varchar(120),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  max_activations int CHECK (max_activations IS NULL OR max_activations >= 1),
  expires_at timestamptz,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  ${TS}
);
CREATE INDEX ix_partner_codes_partner ON partner_codes (partner_id);

CREATE TABLE devices (
  ${PK},
  mac char(17) NOT NULL UNIQUE CHECK (mac ~ '^[0-9A-F]{2}(:[0-9A-F]{2}){5}$'),
  last_installation_id varchar(100),
  last_seen_at timestamptz,
  ${TS}
);

CREATE TABLE activations (
  ${PK},
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  mac char(17) NOT NULL,
  installation_id varchar(100),
  license_id uuid REFERENCES licenses(id) ON DELETE RESTRICT,
  partner_id uuid REFERENCES partners(id) ON DELETE RESTRICT,
  partner_code_id uuid REFERENCES partner_codes(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','revoked')),
  status_reason varchar(500),
  blocked_by varchar(20),
  activated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  claim_pending boolean NOT NULL DEFAULT false,
  idempotency_key varchar(140),
  ${TS},
  CHECK ((license_id IS NOT NULL)::int + (partner_id IS NOT NULL)::int = 1)
);
-- Um MAC só pode ter UMA ativação viva (ativa ou bloqueada). Depois de revogada, pode ser transferido.
CREATE UNIQUE INDEX ux_activations_mac_live ON activations (mac) WHERE status <> 'revoked';
CREATE UNIQUE INDEX ux_activations_idem ON activations (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_activations_license ON activations (license_id);
CREATE INDEX ix_activations_partner ON activations (partner_id);
CREATE INDEX ix_activations_device ON activations (device_id);
CREATE INDEX ix_activations_activated_at ON activations (activated_at DESC);

CREATE TABLE device_sessions (
  ${PK},
  activation_id uuid NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
  refresh_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  ip varchar(64),
  user_agent varchar(300),
  ${TS}
);
CREATE INDEX ix_device_sessions_activation ON device_sessions (activation_id);

CREATE TABLE content_sources (
  ${PK},
  name varchar(160) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'playlist' CHECK (kind IN ('playlist','catalog')),
  scope varchar(20) NOT NULL DEFAULT 'partner' CHECK (scope IN ('global','partner')),
  url_enc text,
  host varchar(255),
  delivery_mode varchar(20) NOT NULL DEFAULT 'redirect' CHECK (delivery_mode IN ('redirect','proxy')),
  signing jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  notes text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  ${TS},
  CHECK (kind <> 'playlist' OR url_enc IS NOT NULL)
);

CREATE TABLE categories (
  ${PK},
  source_id uuid NOT NULL REFERENCES content_sources(id) ON DELETE CASCADE,
  name varchar(160) NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  ${TS},
  UNIQUE (source_id, name)
);

CREATE TABLE channels (
  ${PK},
  source_id uuid NOT NULL REFERENCES content_sources(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  external_id varchar(120),
  name varchar(200) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'live' CHECK (kind IN ('live','movie','series')),
  stream_url_enc text NOT NULL,
  logo_url text,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  sort_order int NOT NULL DEFAULT 0,
  ${TS}
);
CREATE UNIQUE INDEX ux_channels_external ON channels (source_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX ix_channels_source ON channels (source_id);

CREATE TABLE partner_sources (
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES content_sources(id) ON DELETE CASCADE,
  ${TS},
  PRIMARY KEY (partner_id, source_id)
);

CREATE TABLE invoices (
  ${PK},
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  competence char(7) NOT NULL CHECK (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  device_count int NOT NULL DEFAULT 0,
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  paid_cents int NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  due_date date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','paid','overdue','cancelled')),
  paid_at timestamptz,
  breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  ${TS},
  UNIQUE (partner_id, competence)
);
CREATE INDEX ix_invoices_status_due ON invoices (status, due_date);

CREATE TABLE payments (
  ${PK},
  invoice_id uuid REFERENCES invoices(id) ON DELETE RESTRICT,
  license_id uuid REFERENCES licenses(id) ON DELETE RESTRICT,
  amount_cents int NOT NULL CHECK (amount_cents > 0),
  method varchar(30),
  provider varchar(30) NOT NULL DEFAULT 'manual',
  provider_ref varchar(120),
  origin varchar(20) NOT NULL CHECK (origin IN ('webhook','admin')),
  status varchar(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','refunded')),
  confirmed_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  note varchar(500),
  paid_at timestamptz NOT NULL DEFAULT now(),
  ${TS},
  CHECK ((invoice_id IS NOT NULL)::int + (license_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX ux_payments_provider_ref ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX ix_payments_invoice ON payments (invoice_id);
CREATE INDEX ix_payments_license ON payments (license_id);

CREATE TABLE renewals (
  ${PK},
  license_id uuid NOT NULL REFERENCES licenses(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  previous_expires_at timestamptz,
  new_expires_at timestamptz NOT NULL,
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  ${TS}
);
CREATE INDEX ix_renewals_license ON renewals (license_id);

CREATE TABLE webhook_events (
  ${PK},
  provider varchar(30) NOT NULL,
  event_id varchar(120) NOT NULL,
  payload jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  error text,
  processed_at timestamptz,
  ${TS},
  UNIQUE (provider, event_id)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_type varchar(20) NOT NULL,
  actor_id varchar(64),
  action varchar(80) NOT NULL,
  entity_type varchar(40),
  entity_id varchar(64),
  result varchar(10) NOT NULL DEFAULT 'success' CHECK (result IN ('success','failure')),
  ip varchar(64),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_created ON audit_logs (created_at DESC);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id);
CREATE INDEX ix_audit_action ON audit_logs (action);
`;

const TABLES = [
  "audit_logs", "webhook_events", "renewals", "payments", "invoices", "partner_sources", "channels",
  "categories", "content_sources", "device_sessions", "activations", "devices", "partner_codes",
  "licenses", "customers", "auth_sessions", "admin_users", "partners", "plans",
];

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query(UP, { transaction });
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      for (const t of TABLES) {
        await queryInterface.sequelize.query(`DROP TABLE IF EXISTS ${t} CASCADE`, { transaction });
      }
    });
  },
};
