"use strict";
// NÃO VALIDADA em PostgreSQL neste ambiente (sem banco). Rode: npm run verify:db (ver docs/04-verificacao.md).
const PK = `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`;
const TS = `created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()`;

/*
 * Catálogo persistente e versionado.
 *  - Uma IMPORTAÇÃO (catalog_imports) pertence a uma fonte global/de parceria (source_id) OU a uma ativação (playlist/credenciais pessoais).
 *  - Só uma importação 'ativa' por escopo (índices parciais): a publicação troca a ativa numa única transação.
 *  - Itens/pastas/séries ficam presos à importação (ON DELETE CASCADE): limpar versões antigas = apagar a importação.
 *  - O id do item é estável entre versões (mesmo id em importações diferentes); a chave é (import_id, id).
 *  - seq = posição na playlist; é a base do cursor (ordem estável dentro da pasta, independente de nomes).
 *  - origin_enc = URL de origem cifrada (pode conter usuário/senha do provedor). Nunca sai do servidor.
 */
const UP = `
CREATE TABLE catalog_imports (
  ${PK},
  source_id uuid REFERENCES content_sources(id) ON DELETE CASCADE,
  activation_id uuid REFERENCES activations(id) ON DELETE CASCADE,
  status varchar(12) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','superseded')),
  is_active boolean NOT NULL DEFAULT false,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  item_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(40),
  error_message varchar(500),
  locked_by varchar(80),
  lock_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  published_at timestamptz,
  ${TS},
  CHECK ((source_id IS NOT NULL)::int + (activation_id IS NOT NULL)::int = 1),
  CHECK (NOT is_active OR status = 'ready')
);
CREATE UNIQUE INDEX ux_catalog_active_source ON catalog_imports (source_id) WHERE is_active AND source_id IS NOT NULL;
CREATE UNIQUE INDEX ux_catalog_active_activation ON catalog_imports (activation_id) WHERE is_active AND activation_id IS NOT NULL;
-- Coordenação entre instâncias: no máximo uma importação em andamento por escopo.
CREATE UNIQUE INDEX ux_catalog_running_source ON catalog_imports (source_id) WHERE status IN ('queued','running') AND source_id IS NOT NULL;
CREATE UNIQUE INDEX ux_catalog_running_activation ON catalog_imports (activation_id) WHERE status IN ('queued','running') AND activation_id IS NOT NULL;
CREATE INDEX ix_catalog_imports_source ON catalog_imports (source_id, created_at DESC);
CREATE INDEX ix_catalog_imports_activation ON catalog_imports (activation_id, created_at DESC);

CREATE TABLE catalog_groups (
  import_id uuid NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  id varchar(40) NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('live','movie','series')),
  name varchar(300) NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  item_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (import_id, id)
);
CREATE INDEX ix_catalog_groups_kind ON catalog_groups (import_id, kind, sort_order, name);

CREATE TABLE catalog_series (
  import_id uuid NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  id varchar(40) NOT NULL,
  group_id varchar(40) NOT NULL,
  title varchar(500) NOT NULL,
  logo text,
  seq int NOT NULL,
  season_count int NOT NULL DEFAULT 0,
  episode_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (import_id, id),
  FOREIGN KEY (import_id, group_id) REFERENCES catalog_groups (import_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_catalog_series_group ON catalog_series (import_id, group_id, seq);
CREATE INDEX ix_catalog_series_seq ON catalog_series (import_id, seq);

CREATE TABLE catalog_items (
  import_id uuid NOT NULL REFERENCES catalog_imports(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('live','movie','series')),
  group_id varchar(40) NOT NULL,
  seq int NOT NULL,
  title varchar(500) NOT NULL,
  tvg_name varchar(500),
  tvg_id varchar(200),
  logo text,
  series_id varchar(40),
  season int,
  episode int,
  episode_title varchar(500),
  ext varchar(8) NOT NULL DEFAULT '',
  origin_enc text NOT NULL,
  strong_key char(64) NOT NULL,
  weak_key char(64) NOT NULL,
  PRIMARY KEY (import_id, id),
  FOREIGN KEY (import_id, group_id) REFERENCES catalog_groups (import_id, id) ON DELETE CASCADE
);
-- Navegação por pasta com cursor em seq (ordem estável).
CREATE UNIQUE INDEX ux_catalog_items_group_seq ON catalog_items (import_id, kind, group_id, seq);
-- Episódios de uma série/temporada.
CREATE INDEX ix_catalog_items_series ON catalog_items (import_id, series_id, season, episode) WHERE series_id IS NOT NULL;
-- Correspondência de ids entre versões.
CREATE INDEX ix_catalog_items_strong ON catalog_items (import_id, strong_key);
CREATE INDEX ix_catalog_items_weak ON catalog_items (import_id, weak_key);
`;

const DOWN = `
DROP TABLE IF EXISTS catalog_items;
DROP TABLE IF EXISTS catalog_series;
DROP TABLE IF EXISTS catalog_groups;
DROP TABLE IF EXISTS catalog_imports;
`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
