'use strict';
/** Etapa 4: agregados de tráfego do PLAYERWEB atribuídos ao Parceiro de Conteúdo.
 * Forward-only; sem modificação em sessões, licenças ou dispositivos legados.
 */
module.exports={
 async up(q){await q.sequelize.transaction(async transaction=>{
  await q.sequelize.query(`
 CREATE TABLE partner_portal_usage_flushes(
   batch_id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE partner_portal_usage_hourly(
   bucket_at timestamptz NOT NULL,
   partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
   device_id uuid NOT NULL,
   media_kind varchar(12) NOT NULL CHECK(media_kind IN ('live','movie','series','hls','api','epg')),
   transport varchar(20) NOT NULL CHECK(transport IN ('node','redirect','nginx_unmetered')),
   bytes_out bigint NOT NULL DEFAULT 0 CHECK(bytes_out>=0),
   request_count bigint NOT NULL DEFAULT 0 CHECK(request_count>=0),
   error_count bigint NOT NULL DEFAULT 0 CHECK(error_count>=0),
   duration_ms bigint NOT NULL DEFAULT 0 CHECK(duration_ms>=0),
   PRIMARY KEY(bucket_at,partner_id,device_id,media_kind,transport)
 );
 CREATE INDEX idx_portal_usage_owner_month ON partner_portal_usage_hourly(partner_id,bucket_at DESC);
 CREATE TABLE partner_portal_usage_alert_settings(
   singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK(singleton_id=1),
   monthly_node_gb_budget integer NOT NULL DEFAULT 0 CHECK(monthly_node_gb_budget BETWEEN 0 AND 10000000),
   master_monthly_node_gb_budget integer NOT NULL DEFAULT 0 CHECK(master_monthly_node_gb_budget BETWEEN 0 AND 10000000),
   cpu_percent smallint NOT NULL DEFAULT 85 CHECK(cpu_percent BETWEEN 1 AND 100),
   memory_percent smallint NOT NULL DEFAULT 85 CHECK(memory_percent BETWEEN 1 AND 100),
   storage_percent smallint NOT NULL DEFAULT 85 CHECK(storage_percent BETWEEN 1 AND 100),
   retention_days integer NOT NULL DEFAULT 60 CHECK(retention_days BETWEEN 7 AND 365),
   updated_at timestamptz NOT NULL DEFAULT now()
 );
 INSERT INTO partner_portal_usage_alert_settings(singleton_id) VALUES(1);
 COMMENT ON TABLE partner_portal_usage_hourly IS 'Somente bytes servidos por Node no PlayerWeb; X-Accel/Nginx fica identificado sem metragem, e redirects nunca são tratados como tráfego de origem observado.';
 COMMENT ON COLUMN partner_portal_usage_hourly.device_id IS 'UUID do dispositivo; UUID zero representa medição sem dispositivo individual.';
 `,{transaction});
 });},
 async down(){throw new Error('Migração forward-only: relatórios de tráfego históricos não são excluídos automaticamente.');}
};
