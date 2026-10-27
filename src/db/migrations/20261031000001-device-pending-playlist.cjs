"use strict";
/*
 * Lista (por link) enviada pelo site para um MAC que AINDA NÃO tem licença individual.
 * O cadastro é aceito e guardado no dispositivo (cifrado); quando a licença for ativada nele, a lista passa para a
 * ativação (activations.playlist_*) e estas colunas são limpas. Sem licença, nada é entregue à TV.
 */
const UP = `
ALTER TABLE devices
  ADD COLUMN pending_playlist_name varchar(160),
  ADD COLUMN pending_playlist_url_enc text,
  ADD COLUMN pending_playlist_at timestamptz;
`;
const DOWN = `
ALTER TABLE devices
  DROP COLUMN pending_playlist_at,
  DROP COLUMN pending_playlist_url_enc,
  DROP COLUMN pending_playlist_name;
`;
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
