"use strict";
/*
 * Downloads de aplicativos para os revendedores.
 *
 *  - app_downloads: o admin cadastra o nome do app, a versão, o link de download e o código numérico do app "Downloader"
 *    (o código que se digita na TV). O revendedor só enxerga a lista (somente leitura) no portal dele.
 *  - Tabela nova e independente: não altera nenhuma tabela existente.
 */
const UP = `
CREATE TABLE app_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  version varchar(40),
  download_url text NOT NULL,
  downloader_code varchar(20),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_app_downloads_name ON app_downloads (name);
`;
const DOWN = `DROP TABLE IF EXISTS app_downloads;`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
