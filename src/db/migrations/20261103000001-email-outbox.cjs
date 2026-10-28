"use strict";
/*
 * Saída de e-mails do painel (para revendas e clientes).
 *
 *  - email_messages: UMA mensagem escrita pelo administrador (assunto + texto com {{nome}}) e o público escolhido.
 *  - email_deliveries: UMA linha por destinatário = a fila. O worker pega as pendentes (FOR UPDATE SKIP LOCKED, seguro com
 *    mais de um processo), envia por SMTP e marca sent/failed. Falha temporária volta para pending com espera crescente.
 *  - O histórico guarda quem recebeu e o erro de cada um; a senha do SMTP nunca vai para o banco (só no .env).
 */
const UP = `
CREATE TABLE email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject varchar(200) NOT NULL CHECK (length(btrim(subject)) >= 3),
  body text NOT NULL CHECK (length(btrim(body)) >= 1),
  audience varchar(20) NOT NULL CHECK (audience IN ('resellers','partners','partner','customers','custom')),
  audience_label varchar(200),
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_by_name varchar(160),
  total int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_messages_created ON email_messages (created_at DESC);

CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  to_email varchar(200) NOT NULL,
  to_name varchar(160),
  status varchar(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  error varchar(500),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_email_deliveries_queue ON email_deliveries (next_attempt_at) WHERE status IN ('pending','sending');
CREATE INDEX ix_email_deliveries_message ON email_deliveries (message_id, status);
`;
const DOWN = `DROP TABLE IF EXISTS email_deliveries; DROP TABLE IF EXISTS email_messages;`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(UP, { transaction }));
  },
  async down(queryInterface) {
    await queryInterface.sequelize.transaction((transaction) => queryInterface.sequelize.query(DOWN, { transaction }));
  },
};
