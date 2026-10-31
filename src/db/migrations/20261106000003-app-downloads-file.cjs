"use strict";
/*
 * Downloads: arquivo (APK) hospedado na própria VPS.
 *  - file_name: nome do arquivo guardado em disco (<24 hex>.apk); NULL = o item usa link externo.
 *  - file_size: tamanho em bytes, só para exibir no painel.
 */
const UP = `
ALTER TABLE app_downloads ADD COLUMN file_name varchar(40), ADD COLUMN file_size bigint;
CREATE UNIQUE INDEX ux_app_downloads_file_name ON app_downloads (file_name) WHERE file_name IS NOT NULL;
`;
const DOWN = `
DROP INDEX IF EXISTS ux_app_downloads_file_name;
ALTER TABLE app_downloads DROP COLUMN IF EXISTS file_size, DROP COLUMN IF EXISTS file_name;
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
