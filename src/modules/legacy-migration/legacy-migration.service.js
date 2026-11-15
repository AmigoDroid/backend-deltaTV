import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { sequelize } from '../../db/models/index.js';
import { audit } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { assessLegacyRecord } from './legacy-migration.policy.js';

const query = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const fail = (code, message, status = 409) => { throw new AppError(status, code, message); };

/** Inventário paginado e por parceiro, somente leitura. Nunca consulta outras carteiras sem escopo. */
export async function previewLegacy(partnerId, { page = 1, pageSize = 30 } = {}) {
  const params = { partnerId, limit: pageSize, offset: (page - 1) * pageSize };
  const [list, counts, missing] = await Promise.all([
    query(`SELECT r.id AS "legacyClientId", r.partner_id AS "partnerId", r.name, r.mac, r.phone,
        c.id AS "commerceCustomerId",
        ac.n AS "activationCount", ac.id AS "activationId", ac.status AS "activationStatus",
        l.status AS "licenseStatus", l.expires_at AS "licenseExpiresAt",
        l.owner_partner_id AS "licenseOwnerPartnerId",
        d.platform, d.app_version AS "appVersion", d.identifier_type AS "identifierType",
        COALESCE(others.n,0)::int AS "otherPartnerCount",
        sl.subscription_id AS "linkedSubscriptionId"
      FROM reseller_clients r
      LEFT JOIN commerce_customers c ON c.legacy_reseller_client_id=r.id AND c.partner_id=r.partner_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n,
          (array_agg(a.id ORDER BY a.activated_at DESC))[1] AS id,
          (array_agg(a.status ORDER BY a.activated_at DESC))[1] AS status
        FROM activations a WHERE a.partner_id=r.partner_id AND a.mac=r.mac AND a.status <> 'revoked'
      ) ac ON true
      LEFT JOIN activations a ON a.id=ac.id
      LEFT JOIN devices d ON d.id=a.device_id
      LEFT JOIN licenses l ON l.id=COALESCE(a.granted_license_id,a.license_id)
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT other.partner_id)::int AS n FROM activations other
        WHERE other.mac=r.mac AND other.partner_id IS DISTINCT FROM r.partner_id AND other.status <> 'revoked'
      ) others ON true
      LEFT JOIN LATERAL (
        SELECT sl2.subscription_id FROM commerce_subscription_slots sl2
        WHERE sl2.partner_id=r.partner_id AND sl2.mac=r.mac AND sl2.released_at IS NULL LIMIT 1
      ) sl ON true
      WHERE r.partner_id=:partnerId ORDER BY r.created_at DESC,r.id DESC LIMIT :limit OFFSET :offset`, params),
    query('SELECT count(*)::int AS total FROM reseller_clients WHERE partner_id=:partnerId', { partnerId }),
    query(`SELECT count(*)::int AS total FROM activations a WHERE a.partner_id=:partnerId AND a.status <> 'revoked'
      AND NOT EXISTS (SELECT 1 FROM reseller_clients r WHERE r.partner_id=a.partner_id AND r.mac=a.mac)`,{partnerId}),
  ]);
  const data = list.map(row => ({ ...row, ...assessLegacyRecord(row) }));
  const total = Number(counts[0]?.total || 0);
  return { data, meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    summary: data.reduce((acc, row) => { acc[row.state]=(acc[row.state]||0)+1; return acc; }, {}),
    missingClientRecords: Number(missing[0]?.total || 0),
    note: 'Resumo por página. Dispositivos sem ficha legada exigem cadastro e revisão separada. Nenhum dado foi modificado.' };
}

/** Importa APENAS a ficha comercial, sem escolher plano/alterar a licença. Idempotente pelo legado. */
export async function importLegacyCustomer({ partnerId, legacyClientId, actor }) {
  return sequelize.transaction(async transaction => {
    const [legacy] = await query(`SELECT id,partner_id,name,phone,notes FROM reseller_clients
      WHERE id=:legacyClientId AND partner_id=:partnerId FOR UPDATE`, { partnerId, legacyClientId }, transaction);
    if (!legacy) fail('LEGACY_NOT_FOUND', 'Cadastro legado não pertence à revenda selecionada.', 404);
    const [existing] = await query(`SELECT id,name FROM commerce_customers
      WHERE partner_id=:partnerId AND legacy_reseller_client_id=:legacyClientId`, { partnerId, legacyClientId }, transaction);
    if (existing) return { customerId: existing.id, imported: false };
    const [created] = await query(`INSERT INTO commerce_customers
      (partner_id,name,phone,notes,legacy_reseller_client_id)
      VALUES(:partnerId,:name,:phone,:notes,:legacyClientId) RETURNING id`,
      { partnerId, legacyClientId, name: legacy.name, phone: legacy.phone, notes: legacy.notes }, transaction);
    await audit({ actor, action: 'legacy.customer.import', entityType: 'commerce_customer', entityId: created.id,
      metadata: { partnerId, legacyClientId }, transaction });
    return { customerId: created.id, imported: true };
  });
}

/**
 * Associa uma licença JÁ EXISTENTE a assinatura comercial explicitamente aprovada.
 * Não emite, transfere, renova, libera, troca MAC, cria cobranças ou desconta estoque.
 * A identificação é por (partnerId,legacyClientId,activationId), jamais por MAC isolado.
 */
export async function linkLegacyActivation({ partnerId, legacyClientId, activationId, subscriptionId,
  acknowledgeSharedMac = false, actor }) {
  try { return await sequelize.transaction(async transaction => {
    const [{ id: customerId } = {}] = await query(`SELECT c.id FROM commerce_customers c
      JOIN reseller_clients r ON r.id=c.legacy_reseller_client_id AND r.partner_id=c.partner_id
      WHERE r.id=:legacyClientId AND r.partner_id=:partnerId`, { partnerId, legacyClientId }, transaction);
    if (!customerId) fail('IMPORT_CUSTOMER_FIRST', 'Importe primeiro o cadastro comercial desta revenda.');
    const [subscription] = await query(`SELECT id,customer_id,partner_id,state,kind,slots_snapshot
      FROM commerce_subscriptions WHERE id=:subscriptionId AND partner_id=:partnerId FOR UPDATE`,
      { subscriptionId, partnerId }, transaction);
    if (!subscription || subscription.customer_id !== customerId || subscription.kind !== 'customer' || subscription.state !== 'active') {
      fail('SUBSCRIPTION_MISMATCH', 'Selecione uma assinatura comercial ativa deste mesmo cliente.');
    }
    const [activation] = await query(`SELECT a.id,a.mac,a.status,l.status AS license_status,
      l.expires_at AS license_expires_at,l.owner_partner_id AS license_owner_partner_id
      FROM activations a JOIN reseller_clients r ON r.mac=a.mac AND r.partner_id=a.partner_id
      LEFT JOIN licenses l ON l.id=COALESCE(a.granted_license_id,a.license_id)
      WHERE r.id=:legacyClientId AND a.id=:activationId AND a.partner_id=:partnerId FOR UPDATE OF a`,
      { partnerId, legacyClientId, activationId }, transaction);
    if (!activation) fail('ACTIVATION_MISMATCH', 'Ativação não pertence ao cadastro e parceiro informados.');
    if (activation.status !== 'active' || activation.license_status !== 'active' ||
        !activation.license_expires_at || new Date(activation.license_expires_at).getTime() <= Date.now()) {
      fail('LICENSE_NOT_ACTIVE', 'Somente uma ativação com licença vigente pode ser vinculada.');
    }
    if (activation.license_owner_partner_id && activation.license_owner_partner_id !== partnerId) {
      fail('LICENSE_OWNER_MISMATCH', 'Licença pertence a outra revenda. Revisão manual necessária.');
    }
    const [candidateCount] = await query(`SELECT count(*)::int AS n FROM activations
      WHERE mac=:mac AND partner_id=:partnerId AND status <> 'revoked'`,
      { mac: activation.mac, partnerId }, transaction);
    if (Number(candidateCount?.n || 0) !== 1) fail('MULTIPLE_ACTIVATIONS', 'Ativações ambíguas nesta revenda. Faça revisão antes do vínculo.');
    const [other] = await query(`SELECT count(DISTINCT partner_id)::int AS n FROM activations
      WHERE mac=:mac AND partner_id IS DISTINCT FROM :partnerId AND status <> 'revoked'`,
      { mac: activation.mac, partnerId }, transaction);
    if (Number(other?.n || 0) && !acknowledgeSharedMac) {
      fail('SHARED_MAC_REVIEW', 'Há outro parceiro no mesmo MAC. Confirme conscientemente o vínculo selecionado.');
    }
    const [already] = await query(`SELECT id,subscription_id,activation_id FROM commerce_subscription_slots
      WHERE partner_id=:partnerId AND mac=:mac AND released_at IS NULL FOR UPDATE`,
      { partnerId, mac: activation.mac }, transaction);
    if (already) {
      if (already.subscription_id === subscriptionId && already.activation_id === activationId) {
        return { slotId: already.id, linked: false, alreadyLinked: true };
      }
      fail('SLOT_ALREADY_LINKED', 'Este MAC está vinculado a outro plano ou ativação. Não foi alterado.');
    }
    const [used] = await query(`SELECT count(*)::int AS n FROM commerce_subscription_slots
      WHERE subscription_id=:subscriptionId AND released_at IS NULL`, { subscriptionId }, transaction);
    if (subscription.slots_snapshot != null && Number(used.n) >= Number(subscription.slots_snapshot)) {
      fail('NO_FREE_SLOTS', 'O plano comercial selecionado não possui vagas disponíveis.');
    }
    const [linked] = await query(`INSERT INTO commerce_subscription_slots
      (subscription_id,partner_id,mac,activation_id)
      VALUES(:subscriptionId,:partnerId,:mac,:activationId) RETURNING id`,
      { subscriptionId, partnerId, mac: activation.mac, activationId }, transaction);
    await audit({ actor, action: 'legacy.activation.commercial-link', entityType: 'commerce_subscription', entityId: subscriptionId,
      metadata: { partnerId, legacyClientId, activationId, slotId: linked.id, sharedMacReviewed: !!other?.n }, transaction });
    return { slotId: linked.id, linked: true, alreadyLinked: false };
  }); } catch (error) {
    if (error instanceof UniqueConstraintError || error?.parent?.code === '23505') {
      fail('SLOT_ALREADY_LINKED', 'Esta TV já foi vinculada a uma assinatura. Recarregue a lista antes de tentar novamente.');
    }
    throw error;
  }
}
