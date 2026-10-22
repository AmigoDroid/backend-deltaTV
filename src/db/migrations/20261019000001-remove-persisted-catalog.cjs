"use strict";

/*
 * O app Roku consulta a API Xtream diretamente. O backend não deve importar nem persistir
 * respostas M3U/catálogos completos. Remove as tabelas de catálogo persistente legadas,
 * incluindo origin_enc por item, que podiam acumular centenas de MB.
 * As tabelas de ativação, licença, parceiro, fornecedor e credenciais cifradas permanecem.
 * Esta migration é destrutiva para os catálogos importados; faça backup antes de aplicar.
 */
const UP = `
DROP TABLE IF EXISTS catalog_items CASCADE;
DROP TABLE IF EXISTS catalog_series CASCADE;
DROP TABLE IF EXISTS catalog_groups CASCADE;
DROP TABLE IF EXISTS catalog_imports CASCADE;
`;

// Os dados de catálogo removidos não podem ser reconstruídos sem reimportar a fonte.
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down() {
    throw new Error("Migration destrutiva: catálogos removidos não podem ser restaurados. Recrie o esquema manualmente se necessário.");
  },
};
