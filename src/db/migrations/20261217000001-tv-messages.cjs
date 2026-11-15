'use strict';
/** Comunicados para TVs: campanha, uma entrega por aparelho, ACK auditável. */
module.exports = {
  async up(q) {
    await q.sequelize.query(`
      CREATE TABLE IF NOT EXISTS tv_message_campaigns (
        id UUID PRIMARY KEY,
        sender_user_id UUID NOT NULL,
        sender_partner_id UUID,
        request_id UUID NOT NULL,
        request_hash CHAR(64) NOT NULL,
        audience VARCHAR(12) NOT NULL CHECK (audience IN ('all','selected')),
        title VARCHAR(100) NOT NULL,
        message TEXT NOT NULL CHECK (char_length(message) BETWEEN 3 AND 1200),
        expires_at TIMESTAMPTZ NOT NULL,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (sender_user_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS tv_message_deliveries (
        id UUID PRIMARY KEY,
        campaign_id UUID NOT NULL REFERENCES tv_message_campaigns(id) ON DELETE CASCADE,
        device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
        activation_id UUID REFERENCES activations(id) ON DELETE SET NULL,
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (campaign_id,device_id)
      );
      CREATE INDEX IF NOT EXISTS tv_message_campaigns_sender_idx
        ON tv_message_campaigns(sender_user_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS tv_message_campaigns_partner_idx
        ON tv_message_campaigns(sender_partner_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS tv_message_deliveries_pending_idx
        ON tv_message_deliveries(activation_id,read_at,created_at DESC);
      CREATE INDEX IF NOT EXISTS tv_message_deliveries_campaign_idx
        ON tv_message_deliveries(campaign_id,read_at);
    `);
  },
  // Preservar histórico de comunicados e leituras em eventual rollback de código.
  async down() { throw new Error('Migração forward-only: não destruir histórico de mensagens para TVs.'); },
};
