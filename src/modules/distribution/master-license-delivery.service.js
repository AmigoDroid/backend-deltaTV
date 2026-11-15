import crypto from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize, Partner } from '../../db/models/index.js';
import { AppError } from '../../shared/errors.js';
import { audit } from '../../shared/audit.js';
import { move as stockMove, balancesOf } from '../stock/stock-ledger.js';
import { requireMaster } from './network.service.js';
import { effectiveResources } from './network.resources.js';
import { effectivePartnerStatus } from '../access/access.policy.js';

const read = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const write = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.RAW });

/**
 * Entrega explícita de licenças do estoque do Master a uma revenda direta.
 * NÃO registra recebimento financeiro, nem gera comissão automática:
 * o pagamento externo informado pelo Master não é verificado pelo DeltaTV.
 */
export async function deliverLicenses(sellerId, { buyerPartnerId, months, quantity, idempotencyKey, purpose, note = '' }, actor) {
  const transferId = crypto.randomUUID();
  const result = await sequelize.transaction(async transaction => {
    await write('SELECT pg_advisory_xact_lock(hashtext(:key))', {key:`master-license-delivery:${sellerId}:${idempotencyKey}`}, transaction);
    const earlier = (await read(`SELECT id,buyer_partner_id,months,quantity,purpose,transfer_id,created_at
      FROM reseller_master_license_deliveries
      WHERE seller_partner_id = :seller AND idempotency_key = :key`, {seller:sellerId,key:idempotencyKey}, transaction))[0];
    if (earlier) {
      if (earlier.buyer_partner_id !== buyerPartnerId || Number(earlier.months) !== months || Number(earlier.quantity) !== quantity || earlier.purpose !== purpose)
        throw new AppError(409,'DELIVERY_KEY_CONFLICT','Esta identificação já foi usada para outra entrega.');
      return {id:earlier.id,transferId:earlier.transfer_id,months,quantity,purpose,buyerPartnerId,alreadyProcessed:true};
    }
    const locked = await Partner.findAll({where:{id:[sellerId,buyerPartnerId].sort()},transaction,lock:transaction.LOCK.UPDATE});
    const seller = locked.find(p => p.id === sellerId);
    const buyer = locked.find(p => p.id === buyerPartnerId);
    if (!seller || !buyer || buyer.parentPartnerId !== sellerId)
      throw new AppError(403,'NOT_DIRECT_RESELLER','Só é possível entregar licenças a uma revenda diretamente vinculada.');
    await requireMaster(sellerId,'canSell',transaction);
    const sellerResources=await effectiveResources(sellerId,transaction);
    const buyerResources=await effectiveResources(buyerPartnerId,transaction);
    if(!sellerResources.stock.enabled||!buyerResources.stock.enabled)
      throw new AppError(403,'NETWORK_RESOURCE_DISABLED','O estoque de licenças está desabilitado para uma das contas.');
    if (buyer.status !== 'active' || effectivePartnerStatus(buyer) !== 'active')
      throw new AppError(409,'BUYER_INACTIVE','A conta destinatária precisa estar ativa.');
    if (seller.id === buyer.id) throw new AppError(422,'INVALID_DELIVERY','Escolha outra conta da sua rede.');
    const memo = purpose === 'external_payment'
      ? 'Entrega de licenças — pagamento externo declarado, não verificado pelo DeltaTV'
      : 'Distribuição sem cobrança pelo DeltaTV';
    const annotatedNote = note ? `${memo} · ${note}` : memo;
    // A saída e a entrada são atômicas. O ledger rejeita estoque insuficiente.
    await stockMove(transaction,{partnerId:sellerId,months,delta:-quantity,kind:'transfer_out',actor,transferId,
      counterpartyPartnerId:buyerPartnerId,note:annotatedNote});
    await stockMove(transaction,{partnerId:buyerPartnerId,months,delta:quantity,kind:'transfer_in',actor,transferId,
      counterpartyPartnerId:sellerId,note:annotatedNote});
    const [row] = await read(`INSERT INTO reseller_master_license_deliveries
      (seller_partner_id,buyer_partner_id,idempotency_key,transfer_id,months,quantity,purpose,note,actor_user_id)
      VALUES(:seller,:buyer,:key,:transfer,:months,:quantity,:purpose,:note,:actor)
      RETURNING id,created_at`,{seller:sellerId,buyer:buyerPartnerId,key:idempotencyKey,transfer:transferId,
      months,quantity,purpose,note:note||null,actor:actor?.id??null},transaction);
    await audit({actor,action:'distribution.license_delivery',entityType:'partner',entityId:sellerId,
      metadata:{deliveryId:row.id,buyerPartnerId,months,quantity,purpose,transferId,paymentVerifiedByPlatform:false},transaction});
    return {id:row.id,transferId,months,quantity,purpose,buyerPartnerId,alreadyProcessed:false};
  });
  return {...result,stock:await balancesOf(sellerId)};
}

export async function deliveryByKey(sellerId,key) {
  const [row] = await read(`SELECT id,buyer_partner_id AS "buyerPartnerId",months,quantity,purpose,
      transfer_id AS "transferId",created_at AS "createdAt"
    FROM reseller_master_license_deliveries WHERE seller_partner_id = :seller AND idempotency_key = :key`,
    {seller:sellerId,key});
  return {delivery:row||null};
}

export async function listDeliveries(sellerId,{admin=false}={}) {
  if (!admin) await requireMaster(sellerId,'canSell');
  const rows = await read(`SELECT d.id,d.months,d.quantity,d.purpose,d.created_at AS "createdAt",
      d.transfer_id AS "transferId",p.name AS "buyerName"
      FROM reseller_master_license_deliveries d
      JOIN partners p ON p.id=d.buyer_partner_id
      WHERE d.seller_partner_id = :id ORDER BY d.created_at DESC LIMIT 100`,{id:sellerId});
  return {data:rows};
}
