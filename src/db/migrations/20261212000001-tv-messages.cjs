'use strict';
module.exports = {
 async up(q) {
  await q.sequelize.transaction(async transaction => {
   await q.sequelize.query(`CREATE TABLE tv_message_campaigns (
    id uuid PRIMARY KEY, sender_id uuid NOT NULL, partner_id uuid,
    request_id uuid NOT NULL, payload_hash varchar(64) NOT NULL,
    title varchar(100) NOT NULL, message varchar(1200) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT NOW(), expires_at timestamptz NOT NULL,
    cancelled_at timestamptz, UNIQUE(sender_id, request_id));
   CREATE TABLE tv_message_deliveries (
    campaign_id uuid NOT NULL REFERENCES tv_message_campaigns(id) ON DELETE CASCADE,
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    activation_id uuid NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
    read_at timestamptz, PRIMARY KEY(campaign_id,device_id));
   CREATE INDEX tv_message_inbox_idx ON tv_message_deliveries(device_id,campaign_id) WHERE read_at IS NULL;
   CREATE INDEX tv_message_owner_idx ON tv_message_campaigns(partner_id,created_at DESC);`, { transaction });
  });
 },
 async down(q) { await q.sequelize.transaction(async transaction => {
  await q.dropTable('tv_message_deliveries',{transaction});
  await q.dropTable('tv_message_campaigns',{transaction});
 }); }
};
