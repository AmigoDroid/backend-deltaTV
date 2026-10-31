"use strict";
/*
 * Downloads: além de aplicativos, o admin também pode cadastrar links comuns (tutorial, painel, site...).
 *  - app_downloads.kind: 'app' (padrão, o que já existe) ou 'link'. Os registros atuais continuam como 'app'.
 */
const UP = `
ALTER TABLE app_downloads ADD COLUMN kind varchar(10) NOT NULL DEFAULT 'app' CHECK (kind IN ('app','link'));
`;
const DOWN = `ALTER TABLE app_downloads DROP COLUMN IF EXISTS kind;`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
