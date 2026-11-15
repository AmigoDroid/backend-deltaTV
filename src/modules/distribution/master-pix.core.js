import { QueryTypes } from 'sequelize';
import { sequelize, Partner } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { move as stockMove } from '../stock/stock-ledger.js';
import { requireMaster } from './network.service.js';
import { effectiveResources } from './network.resources.js';
import { canDeliver } from './master-pix.policy.js';

/** Núcleo comum a todos os meios de pagamento: entrega e liberação de reserva em UMA transação. */
export const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
export const exec = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.RAW });
export const fail = (status, code, message) => new AppError(status, code, message);
export const chooseOrder = async (id, transaction, lock = false) =>
  (await select(`SELECT * FROM reseller_master_pix_orders WHERE id=:id ${lock ? 'FOR UPDATE' : ''}`, { id }, transaction))[0];
export const GLOBAL_LOCK = 'SELECT pg_advisory_xact_lock(99111701)';
const SYSTEM = { type: 'system', name: 'Pix Master' };

export async function markReview(t, id, reason, { paidAt = null } = {}) {
  return (await select(`UPDATE reseller_master_pix_orders SET status='review',review_reason=:reason,
    paid_at=COALESCE(:paidAt,paid_at),checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`,
  { id, reason, paidAt }, t))[0];
}

/** Entrega as licenças da reserva ao comprador. Se vínculo/permissão mudou, vai para conferência (nada é entregue "no escuro"). */
export async function deliverPaid(t, current, { paidAt, actor = SYSTEM, txn = null, slug = null, confirmedBy = null, via = 'provider' } = {}) {
  const locked = await Partner.findAll({ where: { id: [current.buyer_partner_id, current.seller_partner_id].sort() }, transaction: t, lock: t.LOCK.UPDATE });
  const buyer = locked.find((p) => p.id === current.buyer_partner_id);
  const seller = locked.find((p) => p.id === current.seller_partner_id);
  let allowed = false;
  try {
    await requireMaster(current.seller_partner_id, 'canSell', t);
    allowed = (await effectiveResources(current.buyer_partner_id, t)).stock.enabled;
  } catch { allowed = false; }
  if (!allowed || !canDeliver(current, buyer, seller)) {
    return markReview(t, current.id, 'Pagamento confirmado, mas vínculo ou permissão mudou; exige conciliação', { paidAt: paidAt || new Date() });
  }
  await stockMove(t, {
    partnerId: current.buyer_partner_id, months: Number(current.months), delta: Number(current.quantity),
    kind: 'transfer_in', counterpartyPartnerId: current.seller_partner_id, transferId: current.id,
    note: `Pix Master ${current.id} confirmado (${current.provider}${via === 'seller' ? ', pelo vendedor' : ''})`, actor,
  });
  await audit({
    actor, action: 'distribution.pix.order.fulfilled', entityType: 'partner', entityId: current.buyer_partner_id,
    metadata: { orderId: current.id, sellerId: current.seller_partner_id, amountCents: Number(current.total_cents), provider: current.provider, via }, transaction: t,
  });
  return (await select(`UPDATE reseller_master_pix_orders SET status='paid',paid_at=:paidAt,fulfilled_at=now(),
    qr_code=NULL,checkout_url=NULL,provider_txn=COALESCE(:txn,provider_txn),provider_slug=COALESCE(:slug,provider_slug),
    confirmed_by_user_id=COALESCE(:confirmedBy,confirmed_by_user_id),checked_at=now(),updated_at=now()
    WHERE id=:id RETURNING *`, { id: current.id, paidAt: paidAt || new Date(), txn, slug, confirmedBy }, t))[0];
}

/** Devolve a reserva ao estoque do vendedor (cancelado, expirado ou estornado antes da entrega). Idempotente. */
export async function releaseReserve(t, current, status, { note = null } = {}) {
  if (!current.released_at && !current.fulfilled_at) {
    await stockMove(t, {
      partnerId: current.seller_partner_id, months: Number(current.months), delta: Number(current.quantity),
      kind: 'transfer_in', counterpartyPartnerId: current.buyer_partner_id, transferId: current.id,
      note: note || `Pix Master ${current.id}: reserva liberada (${status})`, actor: SYSTEM,
    });
  }
  return (await select(`UPDATE reseller_master_pix_orders SET status=:status,released_at=COALESCE(released_at,now()),
    qr_code=NULL,checkout_url=NULL,checked_at=now(),updated_at=now() WHERE id=:id RETURNING *`, { id: current.id, status }, t))[0];
}
