import { buildResellerInviteUrl } from "./invite-onboarding.policy.js";
import crypto from "node:crypto";
import { QueryTypes } from "sequelize";
import { sequelize, Partner, AdminUser } from "../../db/models/index.js";
import { AppError, notFound } from "../../shared/errors.js";
import { audit } from "../../shared/audit.js";
import { move as stockMove, balancesOf } from "../stock/stock-ledger.js";
import { creditMove, creditBalanceOf } from "../credits/credit-ledger.js";
import { ensurePlan } from "../licenses/plan.service.js";
import { effectivePartnerStatus } from "../access/access.policy.js";
import { MAX_NETWORK_QUANTITY, resellerKind, isNetworkMaster, networkPrice, purchaseLegs, canUseInvite, deriveNetworkLabel, expectedPriceMatches } from "./network.policy.js";

const select = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const execute = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.RAW });
const invalid = (message, code = "NETWORK_NOT_ALLOWED") => new AppError(403, code, message);
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

const policyRows = async (id, transaction) => select(`SELECT partner_id, can_invite, can_sell, can_promote, max_children, max_depth
  FROM reseller_network_policies WHERE partner_id=:id`, { id }, transaction);
export async function policyOf(id, transaction) {
  const p = (await policyRows(id, transaction))[0];
  return p ? { canInvite: p.can_invite, canSell: p.can_sell, canPromote: p.can_promote, maxChildren: p.max_children, maxDepth: p.max_depth } : { canInvite: false, canSell: false, canPromote: false, maxChildren: null, maxDepth: null };
}

/** O caminho é percorrido SEM confiar em IDs enviados pelo navegador. Inclui o próprio parceiro. */
export async function lineageOf(id, transaction) {
  const rows = await select(`WITH RECURSIVE ancestry AS (
     SELECT id,parent_partner_id,distribution_role,kind,status,ends_at,0 AS hops,ARRAY[id] AS visited
       FROM partners WHERE id=:id
     UNION ALL
     SELECT p.id,p.parent_partner_id,p.distribution_role,p.kind,p.status,p.ends_at,a.hops+1,a.visited||p.id
       FROM partners p JOIN ancestry a ON a.parent_partner_id=p.id
       WHERE NOT(p.id=ANY(a.visited))
   ) SELECT a.id,a.parent_partner_id,a.distribution_role,a.kind,a.status,a.ends_at,a.hops,
       n.can_invite,n.can_sell,n.can_promote,n.max_children,n.max_depth
       FROM ancestry a LEFT JOIN reseller_network_policies n ON n.partner_id=a.id
       ORDER BY a.hops ASC`, { id }, transaction);
  if (!rows.length) throw notFound("Revenda");
  if (rows[rows.length - 1].parent_partner_id) throw invalid("Hierarquia inválida, circular ou maior que o limite.", "INVALID_HIERARCHY");
  return rows;
}

const policyFromNode = (p) => ({
  canInvite: p.can_invite === true, canSell: p.can_sell === true,
  canPromote: p.can_promote === true, maxChildren: p.max_children == null ? null : Number(p.max_children),
  maxDepth: p.max_depth == null ? null : Number(p.max_depth),
});
export async function requireMaster(partnerId, permission, transaction) {
  const chain = await lineageOf(partnerId, transaction);
  const actor = chain[0];
  if (!isNetworkMaster({ distributionRole: actor.distribution_role, kind: actor.kind })) throw invalid("A conta precisa ser habilitada como Master.");
  // Todos os ascendentes precisam estar ativos e manter a permissão concedida.
  for (let i=0; i<chain.length; i++) {
    const p = chain[i];
    if (p.status !== "active" || (p.ends_at && new Date(p.ends_at).getTime() <= Date.now())) throw invalid("Uma conta da rede está suspensa ou vencida.");
    if (!resellerKind(p.kind)) throw invalid("O vínculo comercial contém uma conta não revendedora.");
    if (i < chain.length - 1 && p.distribution_role !== "master") throw invalid("O nível superior não é Master.");
    const policy = policyFromNode(p);
    if (permission && !policy[permission]) throw invalid("O recurso não foi autorizado para este nível da rede.");
  }
  return { chain, policy: policyFromNode(actor) };
}

const childCount = async (id, transaction) => Number((await select(`SELECT count(*)::int AS count FROM partners WHERE parent_partner_id=:id`, { id }, transaction))[0]?.count ?? 0);
async function assertCanAddChild(id, transaction) {
  const { chain, policy } = await requireMaster(id, "canInvite", transaction);
  if (policy.maxDepth != null && chain.length >= policy.maxDepth) throw invalid("Este Master atingiu a profundidade máxima autorizada.");
  if (policy.maxChildren != null && await childCount(id, transaction) >= policy.maxChildren)
    throw new AppError(409, "NETWORK_CHILD_LIMIT", "Limite de revendas vinculadas atingido.");
  for (let i = 1; i < chain.length; i++) {
    const ancestorDepth = policyFromNode(chain[i]).maxDepth;
    if (ancestorDepth != null && chain.length >= ancestorDepth) throw invalid("O limite de níveis da rede foi atingido.");
  }
}

export async function overview(partnerId, { page = 1, pageSize = 50 } = {}) {
  const safePage = Math.max(1, Math.min(100000, Math.floor(Number(page) || 1)));
  const safeSize = Math.max(1, Math.min(100, Math.floor(Number(pageSize) || 50)));
  const partner = await Partner.findByPk(partnerId, { attributes: ["id","name","kind","distributionRole","parentPartnerId"] });
  if (!partner || !resellerKind(partner.kind)) throw notFound("Revenda");
  const lineage = await lineageOf(partnerId);
  const policy = await policyOf(partnerId);
  const [parent, children, childrenTotal, stock, credits] = await Promise.all([
    partner.parentPartnerId ? Partner.findByPk(partner.parentPartnerId, { attributes: ["id","name"] }) : null,
    select(`SELECT p.id,p.name,p.kind,p.distribution_role,p.status,p.status_reason,p.parent_partner_id,p.contact_email,
                (SELECT count(*)::int FROM partners c WHERE c.parent_partner_id=p.id) AS children_count
          FROM partners p WHERE p.parent_partner_id=:id ORDER BY p.created_at DESC,id DESC
            LIMIT :size OFFSET :offset`, { id: partnerId, size:safeSize, offset:(safePage-1)*safeSize }),
    childCount(partnerId), balancesOf(partnerId), creditBalanceOf(partnerId),
  ]);
  const offers = partner.parentPartnerId ? await listParentPrices(partnerId) : [];
  return { account: { id: partner.id, name: partner.name, role: deriveNetworkLabel(partner.distributionRole, lineage.length-1), kind: partner.kind, distributionRole: partner.distributionRole, parentPartnerId: partner.parentPartnerId }, parent: parent ? { id: parent.id, name: parent.name } : null, depth: lineage.length-1, policy, children, childrenTotal, childrenPage:safePage, childrenPageSize:safeSize, stock, creditBalance: credits, offers };
}

export async function listParentPrices(buyerId) {
  const buyer = await Partner.findByPk(buyerId, { attributes: ["id", "parentPartnerId"] });
  if (!buyer?.parentPartnerId) return [];
  return select(`SELECT months,price_credits AS "priceCredits",active FROM reseller_network_prices
    WHERE partner_id=:parent AND active=true ORDER BY months ASC`, { parent: buyer.parentPartnerId });
}

export async function setPrice(partnerId, { months, priceCredits, active }, actor, {adminOverride=false}={}) {
  await sequelize.transaction(async transaction => {
    const partner=await Partner.findByPk(partnerId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!partner || !isNetworkMaster(partner)) throw invalid("Somente Masters podem definir preços.");
    if(!adminOverride) await requireMaster(partnerId,"canSell",transaction);
    await ensurePlan(months,{transaction});
    await execute(`INSERT INTO reseller_network_prices(partner_id,months,price_credits,active)
      VALUES(:id,:months,:priceCredits,:active) ON CONFLICT(partner_id,months)
      DO UPDATE SET price_credits=EXCLUDED.price_credits,active=EXCLUDED.active,updated_at=now()`,
    { id: partnerId, months, priceCredits, active }, transaction);
    await audit({ actor, action: "distribution.price.set", entityType: "partner", entityId: partnerId, metadata: { months, priceCredits, active }, transaction });
  });
  return { months, priceCredits, active };
}

export async function listOwnPrices(partnerId, {adminOverride=false}={}) {
  if(!adminOverride) await requireMaster(partnerId, "canSell");
  return select(`SELECT months,price_credits AS "priceCredits",active FROM reseller_network_prices WHERE partner_id=:id ORDER BY months`, { id:partnerId });
}

export async function createInvite(partnerId, { maxUses = null, daysValid = null }, actor, portalUrl) {
  const token = crypto.randomBytes(32).toString("base64url");
  const invite = await sequelize.transaction(async transaction => {
    // Serializa convites/cadastro pelo mesmo Master para respeitar limites.
    await Partner.findByPk(partnerId, { transaction, lock: transaction.LOCK.UPDATE });
    await assertCanAddChild(partnerId, transaction);
    const expiresAt = daysValid == null ? null : new Date(Date.now() + daysValid*86400000);
    if (expiresAt && !Number.isFinite(expiresAt.getTime()))
      throw new AppError(422, "INVALID_INVITE_EXPIRY", "A validade informada não é uma data válida.");
    const rows = await select(`INSERT INTO reseller_network_invites(issuer_partner_id,token_hash,expires_at,max_uses,created_by)
      VALUES(:id,:hash,:expires,:uses,:actorId) RETURNING id,expires_at,max_uses,uses`,
      {id:partnerId,hash:hash(token),expires:expiresAt,uses:maxUses,actorId:actor?.id ?? null},transaction);
    await audit({ actor, action: "distribution.invite.created", entityType: "partner", entityId: partnerId, metadata: { inviteId: rows[0].id, maxUses, daysValid }, transaction });
    return rows[0];
  });
  return { id: invite.id, url: buildResellerInviteUrl(portalUrl, token), expiresAt: invite.expires_at, maxUses: invite.max_uses };
}
export async function listInvites(partnerId) {
  await requireMaster(partnerId, "canInvite");
  return select(`SELECT id,expires_at AS "expiresAt",max_uses AS "maxUses",uses,revoked_at AS "revokedAt",created_at AS "createdAt"
    FROM reseller_network_invites WHERE issuer_partner_id=:id ORDER BY created_at DESC LIMIT 30`,{id:partnerId});
}
export async function revokeInvite(partnerId, id, actor) {
  await requireMaster(partnerId, "canInvite");
  await sequelize.transaction(async transaction => {
    const rows = await select(`UPDATE reseller_network_invites SET revoked_at=now()
      WHERE id=:id AND issuer_partner_id=:partner AND revoked_at IS NULL RETURNING id`,{id,partner:partnerId},transaction);
    if (!rows.length) throw notFound("Convite");
    await audit({actor,action:"distribution.invite.revoked",entityType:"partner",entityId:partnerId,metadata:{inviteId:id},transaction});
  });
}

export async function verifyInvite(token) {
  const rows = await select(`SELECT i.expires_at,i.max_uses,i.uses,i.revoked_at,p.id,p.name,p.status,p.distribution_role
    FROM reseller_network_invites i JOIN partners p ON p.id=i.issuer_partner_id WHERE i.token_hash=:hash`, {hash:hash(token)});
  const invite = rows[0];
  if (!canUseInvite(invite) || invite.status !== "active" || invite.distribution_role !== "master") throw new AppError(410, "INVITE_INVALID", "Convite inválido ou vencido.");
  await requireMaster(invite.id, "canInvite");
  return { masterName: invite.name, expiresAt: invite.expires_at };
}

/** Deve ser chamada DENTRO da transação de cadastro; o token nunca aparece nos logs. */
export async function consumeInvite(token, transaction) {
  const rows = await select(`SELECT id,issuer_partner_id,expires_at,max_uses,uses,revoked_at
    FROM reseller_network_invites WHERE token_hash=:hash FOR UPDATE`, {hash:hash(token)}, transaction);
  const invite = rows[0];
  if (!canUseInvite(invite)) throw new AppError(410, "INVITE_INVALID", "Convite inválido ou esgotado.");
  await Partner.findByPk(invite.issuer_partner_id, {transaction,lock:transaction.LOCK.UPDATE});
  await assertCanAddChild(invite.issuer_partner_id, transaction);
  const increment = await select(`UPDATE reseller_network_invites SET uses=uses+1 WHERE id=:id AND (max_uses IS NULL OR uses<max_uses) AND (expires_at IS NULL OR expires_at>now()) AND revoked_at IS NULL
     RETURNING id`, {id:invite.id}, transaction);
  if (!increment.length) throw new AppError(409, "INVITE_EXHAUSTED", "Convite sem vagas disponíveis.");
  return invite.issuer_partner_id;
}

export async function setMaster(partnerId, { master, policy, adminOverride = false, actorParentId = null }, actor) {
  return sequelize.transaction(async transaction => {
    await execute(`SELECT pg_advisory_xact_lock(99111701)`, {}, transaction);
    // All topology-changing operations use the same advisory lock.
    if (actorParentId) {
      const {policy: parentPolicy}=await requireMaster(actorParentId,"canPromote",transaction);
      const requested=policy;
      if ((requested.canInvite&&!parentPolicy.canInvite)||(requested.canSell&&!parentPolicy.canSell)||
          (requested.canPromote&&!parentPolicy.canPromote)||
          (parentPolicy.maxDepth != null && (requested.maxDepth == null || requested.maxDepth > parentPolicy.maxDepth))||
          (parentPolicy.maxChildren != null && (requested.maxChildren == null || requested.maxChildren > parentPolicy.maxChildren)))
        throw new AppError(403,"CAPABILITY_ESCALATION","O Submaster não pode receber mais recursos do que o Master.");
    }
    const target = await Partner.findByPk(partnerId, {transaction,lock:transaction.LOCK.UPDATE});
    if (!target || !resellerKind(target.kind)) throw notFound("Revenda");
    if (actorParentId && target.parentPartnerId !== actorParentId) throw notFound("Revenda desta rede");
    if (actorParentId && target.status !== "active") throw new AppError(409,"INVALID_STATE","Aprovação da revenda é necessária antes de promovê-la.");
    // Do not reduce a policy until the existing subtree fits the new limits.
    if (master) {
      const descendants=(await select(`WITH RECURSIVE subtree AS (
        SELECT id,parent_partner_id,0 AS depth,ARRAY[id] AS visited FROM partners WHERE id=:id
        UNION ALL SELECT p.id,p.parent_partner_id,s.depth+1,s.visited||p.id
          FROM partners p JOIN subtree s ON p.parent_partner_id=s.id
          WHERE NOT (p.id=ANY(s.visited))
      ) SELECT coalesce(max(depth),0)::int AS deepest FROM subtree`,{id:partnerId},transaction))[0];
      const absoluteDepth=(await lineageOf(partnerId,transaction)).length + Number(descendants?.deepest||0);
      if (policy.maxDepth != null && absoluteDepth > policy.maxDepth) throw new AppError(409,"NETWORK_DEPTH_CONFLICT","A nova profundidade é menor que a subárvore existente.");
      if (policy.maxChildren != null && (await childCount(partnerId,transaction)) > policy.maxChildren)
        throw new AppError(409,"NETWORK_CHILD_LIMIT","A nova quota é menor que a quantidade de revendas existentes.");
      if (!policy.canInvite && (await childCount(partnerId,transaction)) > 0)
        throw new AppError(409,"NETWORK_CHILDREN_EXIST","Não é possível desativar convites mantendo subordinados nesta conta.");
    }
    if (!master && (await childCount(partnerId,transaction)) > 0) throw new AppError(409,"HAS_CHILDREN","Transfira as revendas subordinadas antes de desativar o Master.");
    if (master && target.parentPartnerId && !adminOverride) {
      const { policy: parentPolicy } = await requireMaster(target.parentPartnerId, "canPromote", transaction);
      if (!parentPolicy.canPromote) throw invalid("O nível superior não autoriza Submasters.");
    }
    await target.update({ distributionRole: master ? "master" : "reseller" }, {transaction});
    const flags = master ? policy : {canInvite:false,canSell:false,canPromote:false,maxChildren:null,maxDepth:null};
    await execute(`INSERT INTO reseller_network_policies(partner_id,can_invite,can_sell,can_promote,max_children,max_depth)
      VALUES(:id,:invite,:sell,:promote,:children,:depth) ON CONFLICT(partner_id)
      DO UPDATE SET can_invite=EXCLUDED.can_invite,can_sell=EXCLUDED.can_sell,can_promote=EXCLUDED.can_promote,
        max_children=EXCLUDED.max_children,max_depth=EXCLUDED.max_depth,updated_at=now()`,
      {id:partnerId,invite:flags.canInvite,sell:flags.canSell,promote:flags.canPromote,children:flags.maxChildren,depth:flags.maxDepth},transaction);
    await audit({actor,action:master?"distribution.promoted":"distribution.demoted",entityType:"partner",entityId:partnerId,metadata:{policy:flags},transaction});
    return {id:partnerId,role:master?"master":"reseller",policy:flags};
  });
}

export async function attachReseller(childId, parentId, actor) {
  if (childId === parentId) throw new AppError(422,"CYCLE","Uma conta não pode ser sua própria superior.");
  return sequelize.transaction(async transaction => {
    // Serializa mudanças concorrentes de hierarquia e cadastro no mesmo advisory lock global.
    await execute(`SELECT pg_advisory_xact_lock(99111701)`,{},transaction);
    const ids = [childId, parentId].sort();
    const locked = await Partner.findAll({where:{id:ids},transaction,lock:transaction.LOCK.UPDATE});
    const child = locked.find(p=>p.id===childId);
    if (!child || !resellerKind(child.kind)) throw notFound("Revenda");
    if (!locked.some(p=>p.id===parentId)) throw notFound("Master");
    if (child.parentPartnerId && child.parentPartnerId !== parentId) throw new AppError(409,"ALREADY_LINKED","A conta já pertence a outra rede. Transfira por procedimento auditado.");
    if (child.parentPartnerId === parentId) return {id:childId,parentPartnerId:parentId};
    const lineage = await lineageOf(parentId, transaction);
    if (lineage.some(p=>p.id===childId)) throw new AppError(422,"CYCLE","Essa ligação formaria um ciclo na hierarquia.");
    await assertCanAddChild(parentId,transaction);
    // Não move subárvores inteiras: requer migração auditada para evitar ultrapassar limites herdados.
    if (await childCount(childId,transaction)) throw new AppError(409,"HAS_CHILDREN","Não é possível vincular uma conta que já possui revendas subordinadas.");
    const unsettled=(await select(`SELECT count(*)::int AS count FROM pix_charges
      WHERE partner_id=:id AND purpose='stock' AND fulfilled_at IS NULL
        AND provider_ref IS NOT NULL AND status NOT IN ('paid','refunded')`,{id:childId},transaction))[0]?.count;
    if(Number(unsettled)>0) throw new AppError(409,"PENDING_STOCK_PIX","Existem cobranças Pix antigas de estoque ainda sujeitas à conciliação. Resolva-as antes de vincular ao Master.");
    await child.update({parentPartnerId:parentId},{transaction});
    await audit({actor,action:"distribution.linked",entityType:"partner",entityId:childId,metadata:{parentPartnerId:parentId},transaction});
    return {id:childId,parentPartnerId:parentId};
  });
}

export async function detachReseller(childId, actor) {
  return sequelize.transaction(async transaction => {
    await execute(`SELECT pg_advisory_xact_lock(99111701)`,{},transaction);
    const child=await Partner.findByPk(childId,{transaction,lock:transaction.LOCK.UPDATE});
    if(!child) throw notFound("Revenda");
    if(!child.parentPartnerId) return {id:childId,parentPartnerId:null};
    if(await childCount(childId,transaction)) throw new AppError(409,"HAS_CHILDREN","Não é possível desvincular uma conta que possui revendas subordinadas.");
    const previous=child.parentPartnerId;
    await child.update({parentPartnerId:null},{transaction});
    await audit({actor,action:"distribution.unlinked",entityType:"partner",entityId:childId,metadata:{previousParentPartnerId:previous},transaction});
    return {id:childId,parentPartnerId:null};
  });
}

export async function approveChild(parentId, childId, actor, action) {
  await sequelize.transaction(async transaction => {
    await execute(`SELECT pg_advisory_xact_lock(99111701)`, {}, transaction);
    await requireMaster(parentId,"canInvite",transaction);
    await Partner.findByPk(parentId, { transaction, lock: transaction.LOCK.UPDATE });
    const child=await Partner.findOne({where:{id:childId,parentPartnerId:parentId},transaction,lock:transaction.LOCK.UPDATE});
    if (!child) throw notFound("Revenda desta rede");
    if (action === "reject" && !(child.status === "suspended" && child.statusReason === "Aguardando aprovação do cadastro"))
      throw new AppError(409,"INVALID_STATE","Só cadastros pendentes podem ser recusados.");
    if (action === "approve" && (child.status !== "suspended" || !["Aguardando aprovação do cadastro","Suspensa pelo Master"].includes(child.statusReason)))
      throw new AppError(409,"INVALID_STATE","Somente cadastros pendentes ou suspensos pelo próprio Master podem ser reativados aqui.");
    if (action === "suspend" && child.status !== "active")
      throw new AppError(409,"INVALID_STATE","Somente contas ativas podem ser suspensas pelo Master.");
    await child.update(action === "reject"
      ? {parentPartnerId:null,status:"suspended",statusReason:"Cadastro recusado pelo Master"}
      : {status:action==="approve"?"active":"suspended",statusReason:action==="approve"?null:"Suspensa pelo Master"},
      {transaction});
    await audit({actor,action:`distribution.child.${action}`,entityType:"partner",entityId:childId,metadata:{masterId:parentId},transaction});
  });
}

export async function networkBuy(buyerId, {months,quantity,idempotencyKey,expectedUnitPriceCredits}, actor) {
  const buyer=await Partner.findByPk(buyerId);
  if (!buyer?.parentPartnerId) throw new AppError(422,"NO_MASTER","Sua conta não está vinculada a um Master.");
  const sellerId=buyer.parentPartnerId;
  const transferId=crypto.randomUUID();
  const result=await sequelize.transaction(async transaction => {
    // Reenvio do mesmo comando (dois cliques/rede lenta) não gera compra dupla.
    await execute(`SELECT pg_advisory_xact_lock(hashtext(:key))`,{key:`network-buy:${buyerId}:${idempotencyKey}`},transaction);
    const prev=(await select(`SELECT id,seller_partner_id,months,quantity,unit_price_credits,total_credits,created_at
      FROM reseller_network_sales WHERE buyer_partner_id=:buyer AND idempotency_key=:key`,{buyer:buyerId,key:idempotencyKey},transaction))[0];
    if (prev) {
      if (Number(prev.months)!==months || Number(prev.quantity)!==quantity || prev.seller_partner_id!==sellerId ||
          Number(prev.unit_price_credits)!==expectedUnitPriceCredits)
        throw new AppError(409,"IDEMPOTENCY_MISMATCH","Esta operação já foi utilizada com outros dados.");
      return {id:prev.id,totalCredits:Number(prev.total_credits),months,quantity,replayed:true};
    }
    const locked=await Partner.findAll({where:{id:[buyerId,sellerId].sort()},transaction,lock:transaction.LOCK.UPDATE});
    const currentBuyer=locked.find(p=>p.id===buyerId);
    if (!currentBuyer || currentBuyer.parentPartnerId!==sellerId || currentBuyer.status!=="active" || effectivePartnerStatus(currentBuyer)!=="active") throw invalid("A revenda não está ativa nesta rede.");
    await requireMaster(sellerId,"canSell",transaction);
    await ensurePlan(months,{transaction});
    const price=(await select(`SELECT price_credits FROM reseller_network_prices WHERE partner_id=:seller AND months=:months AND active=true FOR UPDATE`,{seller:sellerId,months},transaction))[0];
    if (!price) throw new AppError(422,"PRICE_NOT_AVAILABLE","Este tipo de licença não está à venda pelo seu Master.");
    if (!expectedPriceMatches(price.price_credits, expectedUnitPriceCredits))
      throw new AppError(409,"PRICE_CHANGED","O preço foi alterado pelo Master. Confira a nova oferta antes de confirmar a compra.");
    const total=networkPrice(Number(price.price_credits),quantity);
    if (!total) throw new AppError(422,"INVALID_PRICE","Preço ou quantidade fora do limite.");
    const note=`Rede: ${quantity} licença(s) de ${months} mês(es), venda ${transferId}`;
    // O mesmo planejamento testado em unidade é aplicado às duas carteiras e aos dois estoques.
    const legs=purchaseLegs({buyerId,sellerId,months,quantity,total});
    if(!legs) throw new AppError(422,"INVALID_PURCHASE","Compra inconsistente.");
    for (const leg of legs.credits) {
      await creditMove(transaction,{partnerId:leg.id,delta:leg.delta,
        kind:leg.id===buyerId?"network_buy":"network_sale",months,quantity,unitPriceCredits:Number(price.price_credits),note,actor});
    }
    for (const leg of legs.stock) {
      await stockMove(transaction,{partnerId:leg.id,months,delta:leg.delta,
        kind:leg.id===sellerId?"transfer_out":"transfer_in",counterpartyPartnerId:leg.id===sellerId?buyerId:sellerId,transferId,note,actor});
    }
    const sale=(await select(`INSERT INTO reseller_network_sales(seller_partner_id,buyer_partner_id,months,quantity,unit_price_credits,total_credits,transfer_id,idempotency_key,actor_user_id)
      VALUES(:seller,:buyer,:months,:quantity,:unit,:total,:transfer,:key,:actor) RETURNING id`,
      {seller:sellerId,buyer:buyerId,months,quantity,unit:Number(price.price_credits),total,transfer:transferId,key:idempotencyKey,actor:actor?.id??null},transaction))[0];
    await audit({actor,action:"distribution.sale",entityType:"partner",entityId:sellerId,
      metadata:{saleId:sale.id,buyerPartnerId:buyerId,months,quantity,unitPriceCredits:Number(price.price_credits),totalCredits:total,transferId},transaction});
    return {id:sale.id,totalCredits:total,months,quantity,replayed:false};
  });
  return { ...result,stock:await balancesOf(buyerId),creditBalance:await creditBalanceOf(buyerId) };
}

export async function purchaseByKey(buyerId, key) {
  const rows=await select(`SELECT id,seller_partner_id AS "sellerPartnerId",months,quantity,
    unit_price_credits AS "unitPriceCredits",total_credits AS "totalCredits",created_at AS "createdAt"
    FROM reseller_network_sales WHERE buyer_partner_id=:buyer AND idempotency_key=:key`,
    {buyer:buyerId,key});
  return rows[0] ?? null;
}

export async function salesFor(partnerId, {as="seller", limit=50}={}) {
  const column=as==="buyer"?"buyer_partner_id":"seller_partner_id";
  return select(`SELECT s.id,s.months,s.quantity,s.unit_price_credits AS "unitPriceCredits",s.total_credits AS "totalCredits",s.created_at AS "createdAt",
      p.name AS "counterpartyName" FROM reseller_network_sales s JOIN partners p ON p.id=s.${as==="buyer"?"seller_partner_id":"buyer_partner_id"}
      WHERE s.${column}=:id ORDER BY s.created_at DESC LIMIT :limit`,{id:partnerId,limit});
}
export async function networkTree(adminId=null,{page=1,pageSize=100,q=""}={}) {
  const id=adminId;
  const safePage=Math.max(1,Math.min(100000,Math.floor(Number(page)||1)));
  const safeSize=Math.max(1,Math.min(200,Math.floor(Number(pageSize)||100)));
  const search=String(q||"").trim().slice(0,80).replace(/[%_]/g,c=>String.fromCharCode(92)+c);
  const result=await select(`WITH RECURSIVE tree AS (
    SELECT id,name,parent_partner_id,distribution_role,kind,status,0 AS depth,ARRAY[id] AS visited,ARRAY[name||id::text] AS sort_path
      FROM partners WHERE ${id?"id=:id":"parent_partner_id IS NULL"} AND kind IN ('reseller','both')
    UNION ALL
    SELECT p.id,p.name,p.parent_partner_id,p.distribution_role,p.kind,p.status,t.depth+1,t.visited||p.id,t.sort_path||(p.name||p.id::text)
      FROM partners p JOIN tree t ON p.parent_partner_id=t.id
      WHERE NOT(p.id=ANY(t.visited))
  ) SELECT id,name,parent_partner_id AS "parentPartnerId",distribution_role AS "distributionRole",status,depth,
      (SELECT count(*)::int FROM tree t2 WHERE (:search = '' OR t2.name ILIKE :pattern OR t2.id::text ILIKE :pattern)) AS "totalCount"
    FROM tree WHERE (:search = '' OR name ILIKE :pattern OR id::text ILIKE :pattern)
    ORDER BY sort_path LIMIT :size OFFSET :offset`,
    {id,size:safeSize,offset:(safePage-1)*safeSize,search,pattern:`%${search}%`});
  return {data:result.map(({totalCount,...row})=>row),total:result.length?Number(result[0].totalCount):0,page:safePage,pageSize:safeSize};
}

/** Árvore integral sob o Master, sem permitir que ele veja redes externas. */
export async function descendantTree(partnerId,options={}) {
  await requireMaster(partnerId, "canInvite");
  return networkTree(partnerId,options);
}

/** Indicadores da rede usando a mesma árvore de vínculos, sem expor credenciais dos clientes. */
export async function networkSummary(partnerId) {
  await requireMaster(partnerId,"canInvite");
  const rows=await select(`WITH RECURSIVE members AS (
    SELECT id,0 AS depth,ARRAY[id] AS path FROM partners WHERE id=:id
    UNION ALL
    SELECT p.id,m.depth+1,m.path||p.id FROM partners p JOIN members m ON p.parent_partner_id=m.id
     WHERE NOT(p.id=ANY(m.path))
  ) SELECT
    (SELECT count(*)::int FROM members WHERE depth>0) AS resellers,
    (SELECT count(*)::int FROM partners p JOIN members m ON m.id=p.id WHERE m.depth>0 AND p.distribution_role='master') AS submasters,
    (SELECT count(*)::int FROM activations a JOIN members m ON m.id=a.partner_id WHERE a.status='active') AS active_activations,
    (SELECT coalesce(sum(quantity),0)::bigint FROM license_stock s JOIN members m ON m.id=s.partner_id) AS stock_units
  `,{id:partnerId});
  const row=rows[0]||{};
  return {resellers:Number(row.resellers||0),submasters:Number(row.submasters||0),activeActivations:Number(row.active_activations||0),stockUnits:Number(row.stock_units||0)};
}
