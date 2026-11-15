'use strict';
/**
 * Migração DUPLICADA de 20261212000001-tv-messages.cjs (mesmas tabelas, colunas diferentes).
 *
 * A 20261212000001 já cria tv_message_campaigns / tv_message_deliveries (sender_id, partner_id, payload_hash...), que é
 * o esquema usado por src/modules/tv-messages/routes.js. Esta versão tentava recriar as tabelas com OUTRAS colunas
 * (sender_user_id, request_hash...). Como o CREATE TABLE era "IF NOT EXISTS", o banco ficava com o esquema antigo e o
 * CREATE INDEX em sender_user_id falhava com 42703 — e como o sequelize-cli para na primeira falha, a migração
 * 20261218000001 (colunas deleted_at de partner_codes/partner_providers) nunca rodava, causando HTTP 500 em
 * GET /api/v1/admin/partners/:id.
 *
 * Agora é segura e idempotente: NÃO cria, altera nem remove nada. Apenas registra qual esquema encontrou, para que
 * `npm run db:migrate` avance até as migrações seguintes sem tocar nos dados de mensagens.
 */
module.exports = {
  async up(q) {
    const sequelize = q.sequelize;
    const rows = await sequelize.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tv_message_campaigns'`,
      { type: sequelize.QueryTypes.SELECT },
    );
    const cols = new Set(rows.map((r) => r.column_name));
    if (cols.size === 0) {
      console.warn('[20261217000001-tv-messages] tv_message_campaigns não existe; a migração 20261212000001-tv-messages deveria tê-la criado. Nada foi alterado.');
    } else if (cols.has('sender_user_id')) {
      console.warn('[20261217000001-tv-messages] esquema novo (sender_user_id) já presente. Nada foi alterado.');
    } else {
      console.log('[20261217000001-tv-messages] esquema legado (sender_id) preservado. Nada foi alterado.');
    }
  },
  async down() { /* nada a desfazer: esta migração não altera o banco */ },
};
