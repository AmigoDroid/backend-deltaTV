"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db (ver docs/04-verificacao.md).
const PK = `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
const TS = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;

const UP = `

-- Dispositivos deixam de depender de MAC. Todos os registros existentes viram plataforma 'roku' (sem perda).
ALTER TABLE devices ALTER COLUMN mac DROP NOT NULL;
ALTER TABLE activations ALTER COLUMN mac DROP NOT NULL;
ALTER TABLE devices
  ADD COLUMN platform varchar(20) NOT NULL DEFAULT 'roku',
  ADD COLUMN app_id varchar(64) NOT NULL DEFAULT 'delta-tv-roku',
  ADD COLUMN identifier_type varchar(20) NOT NULL DEFAULT 'virtual_mac',
  ADD COLUMN device_key varchar(160),
  ADD COLUMN app_version varchar(40),
  ADD COLUMN first_registered_at timestamptz,
  ADD COLUMN secret_hash char(64),
  ADD COLUMN installation_changed_at timestamptz;
UPDATE devices SET device_key = 'roku:' || mac, first_registered_at = created_at;
ALTER TABLE devices
  ALTER COLUMN device_key SET NOT NULL,
  ALTER COLUMN first_registered_at SET NOT NULL,
  ALTER COLUMN first_registered_at SET DEFAULT now();
CREATE UNIQUE INDEX ux_devices_device_key ON devices (device_key);
-- Compatibilidade: o código legado cria dispositivos informando só o MAC. O gatilho deriva a chave ('roku:<MAC>'),
-- então nada quebra enquanto os serviços não informam plataforma/identificador explicitamente.
CREATE FUNCTION devices_default_key() RETURNS trigger AS $fn$
BEGIN
  IF NEW.device_key IS NULL AND NEW.mac IS NOT NULL THEN NEW.device_key := 'roku:' || NEW.mac; END IF;
  RETURN NEW;
END
$fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_devices_default_key BEFORE INSERT ON devices FOR EACH ROW EXECUTE FUNCTION devices_default_key();
ALTER TABLE devices
  ADD CONSTRAINT ck_devices_platform CHECK (platform IN ('roku','android','tizen','webos','web')),
  ADD CONSTRAINT ck_devices_identifier_type CHECK (identifier_type IN ('virtual_mac','install_uuid','platform_hash')),
  ADD CONSTRAINT ck_devices_roku_has_mac CHECK (platform <> 'roku' OR mac IS NOT NULL);
CREATE INDEX ix_devices_platform ON devices (platform, app_id);
-- Uma ativação viva por dispositivo (generaliza ux_activations_mac_live, que continua valendo para quem tem MAC).
CREATE UNIQUE INDEX ux_activations_device_live ON activations (device_id) WHERE status <> 'revoked';

`;

const DOWN = `

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM devices WHERE mac IS NULL OR platform <> 'roku')
     OR EXISTS (SELECT 1 FROM activations WHERE mac IS NULL) THEN
    RAISE EXCEPTION 'down recusado: existem dispositivos/ativações sem MAC ou de outras plataformas. Nada foi apagado; remova-os conscientemente antes de reverter.';
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_devices_default_key ON devices;
DROP FUNCTION IF EXISTS devices_default_key();
DROP INDEX IF EXISTS ux_activations_device_live;
DROP INDEX IF EXISTS ix_devices_platform;
ALTER TABLE devices
  DROP CONSTRAINT IF EXISTS ck_devices_roku_has_mac,
  DROP CONSTRAINT IF EXISTS ck_devices_identifier_type,
  DROP CONSTRAINT IF EXISTS ck_devices_platform;
DROP INDEX IF EXISTS ux_devices_device_key;
ALTER TABLE devices
  DROP COLUMN installation_changed_at, DROP COLUMN secret_hash, DROP COLUMN first_registered_at,
  DROP COLUMN app_version, DROP COLUMN device_key, DROP COLUMN identifier_type, DROP COLUMN app_id, DROP COLUMN platform;
ALTER TABLE activations ALTER COLUMN mac SET NOT NULL;
ALTER TABLE devices ALTER COLUMN mac SET NOT NULL;

`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
