import crypto from 'node:crypto';
import {QueryTypes} from 'sequelize';
import {sequelize,Partner,AdminUser} from '../../db/models/index.js';
import {AppError} from '../../shared/errors.js';
import {audit} from '../../shared/audit.js';
import {hashPassword} from '../../shared/crypto.js';
import {sendMail} from '../mail/mail.transport.js';
import {env} from '../../config/env.js';
import {addMonthsUtc,safeTotal,resaleAllowed} from './sales.rules.js';
import {packageSnapshot,isPaidInviteReady} from './commercial-v2.rules.js';
import {invalidatePlan} from '../service-plans/plan.service.js';
import {applyServicePackageToPartner} from '../service-packages/package.apply.js';
import {ownPermissions} from './commercial-v2.service.js';
import {PORTAL_INVITE_TTL_MS,normalizePortalInviteEmail,verifyPortalInviteInput,portalInviteUrl} from './invitations.rules.js';

const error=(status,code,message)=>{throw new AppError(status,code,message);};
const read=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,type:QueryTypes.SELECT,transaction});
const run=(sql,replacements={},transaction)=>sequelize.query(sql,{replacements,transaction});
const one=async(sql,replacements={},transaction)=>(await read(sql,replacements,transaction))[0]??null;
const tx=fn=>sequelize.transaction(async t=>{await run('SELECT pg_advisory_xact_lock(99111712)',{},t);return fn(t);});
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
const publicInvalid=()=>new AppError(400,'INVALID_PORTAL_SALES_INVITE','Convite inválido, utilizado, cancelado ou expirado. Solicite outro ao seu distribuidor.');

async function activeSeller(id,t){
  const row=await one(`WITH RECURSIVE path AS (
    SELECT s.partner_id,s.parent_partner_id,s.active,s.can_sell,p.status,ARRAY[s.partner_id] AS visited
    FROM partner_portal_sellers s JOIN partners p ON p.id=s.partner_id WHERE s.partner_id=:id
    UNION ALL
    SELECT parent.partner_id,parent.parent_partner_id,parent.active,parent.can_sell,p.status,path.visited||parent.partner_id
    FROM path JOIN partner_portal_sellers parent ON parent.partner_id=path.parent_partner_id
    JOIN partners p ON p.id=parent.partner_id WHERE NOT parent.partner_id=ANY(path.visited)
  ) SELECT bool_and(active AND can_sell AND status='active') AS allowed,
      count(*) FILTER (WHERE parent_partner_id IS NULL)::int AS roots, count(*)::int AS nodes
    FROM path`,{id},t);
  if(!row?.allowed||row.roots!==1)error(403,'PORTAL_NETWORK_BLOCKED','Vendedor ou Master ancestral sem autorização ativa.');
}
function sellerActor(actor,id){
  if(actor?.type!=='partner'||actor?.role!=='partner'||actor?.partnerId!==id||!actor?.id)
    error(403,'PORTAL_SELLER_REQUIRED','Somente o distribuidor autenticado pode emitir ou cancelar convites da própria rede.');
}
async function assertEmailAvailable(email,t){
  // Proíbe duplicação com usuários ativos de ambos os painéis e com parceiros atuais.
  const duplicate=await one(`SELECT EXISTS(SELECT 1 FROM admin_users WHERE lower(email)=:email)
    OR EXISTS(SELECT 1 FROM partners WHERE lower(contact_email)=:email AND status<>'deleted') AS taken`,{email},t);
  if(duplicate?.taken)error(409,'PORTAL_EMAIL_ALREADY_REGISTERED','E-mail já está cadastrado na plataforma.');
}
async function returnReservation(row,t,status){
  const released=await one(`UPDATE partner_portal_sales_invitations SET status=:status,updated_at=now()
    WHERE id=:id AND status='pending' AND payment_status<>'paid' RETURNING *`,{id:row.id,status},t);
  if(!released)return false;
  if(released.stock_reserved)await run(`UPDATE partner_portal_stock SET available_months=available_months+:months,updated_at=now()
    WHERE seller_partner_id=:seller AND plan_code=:plan`,{months:released.months,seller:released.seller_partner_id,plan:released.plan_code},t);
  if(status==='expired')await audit({actor:{type:'system',id:null},action:'portal.sales.invitation.expired',
    entityType:'partner_portal_sales_invitation',entityId:row.id,metadata:{sellerId:row.seller_partner_id,
      monthsReturned:row.stock_reserved?row.months:0,planCode:row.plan_code},transaction:t});
  return true;
}
/** Recolhe reservas expiradas do vendedor sem cron e sem apagar histórico. */
async function reclaimExpired(sellerId,t){
  const expired=await read(`SELECT * FROM partner_portal_sales_invitations
    WHERE seller_partner_id=:sellerId AND status='pending' AND expires_at<=now() FOR UPDATE`,{sellerId},t);
  for(const row of expired)await returnReservation(row,t,'expired');
  return expired.length;
}
async function reclaimExpiredEmail(email,t){
  const expired=await read(`SELECT * FROM partner_portal_sales_invitations
    WHERE lower(invited_email)=:email AND status='pending' AND expires_at<=now() FOR UPDATE`,{email},t);
  for(const row of expired)await returnReservation(row,t,'expired');
}
export async function listInvitations(sellerId,actor){
  sellerActor(actor,sellerId);
  return tx(async t=>{
    await reclaimExpired(sellerId,t);
    return read(`SELECT id,invited_name,invited_email,invite_type,plan_code,months,unit_resale_cents,
      monthly_fee_cents,status,expires_at,created_at,accepted_at,accepted_partner_id,payment_gateway,payment_status,payment_total_cents,checkout_url,payment_pix_code
      FROM partner_portal_sales_invitations WHERE seller_partner_id=:sellerId
      ORDER BY created_at DESC LIMIT 100`,{sellerId},t);
  });
}
export async function createInvitation({sellerPartnerId,invitedName,invitedEmail,inviteType,planCode,months,unitResaleCents,monthlyFeeCents=0,paymentMode='manual'},actor){
  sellerActor(actor,sellerPartnerId);
  const email=normalizePortalInviteEmail(invitedEmail);
  const token=crypto.randomBytes(32).toString('base64url');
  const tokenHash=hashToken(token);
  // Valida a origem do portal ANTES de reservar estoque: erro de configuração não pode cobrar meses.
  const link=portalInviteUrl(env.partnerPortalUrl,token);
  const expiresAt=new Date(Date.now()+PORTAL_INVITE_TTL_MS);
  const row=await tx(async t=>{
    await activeSeller(sellerPartnerId,t);
    const sellerPermission=await ownPermissions(sellerPartnerId,t);
    if(!sellerPermission.enabled||!sellerPermission.permissions?.canSell)
      error(403,'PANEL_RESALE_FORBIDDEN','Seu plano não permite revender o painel.');
    await reclaimExpired(sellerPartnerId,t);
    await reclaimExpiredEmail(email,t);
    await assertEmailAvailable(email,t);
    const pending=await one(`SELECT id FROM partner_portal_sales_invitations
      WHERE lower(invited_email)=:email AND status='pending'`,{email},t);
    if(pending)error(409,'PORTAL_INVITE_PENDING','Já existe convite comercial pendente para este e-mail.');
    const catalog=await one(`SELECT * FROM service_plan_catalogs
      WHERE key=:planCode AND active=true AND hidden_from_network=false AND audience IN ('content','both')`,{planCode},t);
    if(!catalog)error(409,'PLAN_INACTIVE','Este plano não está disponível para parceiros.');
    // A sale of a plan with resale rights adds a descendant to the hierarchy.
    if((catalog.can_resell_panel||inviteType==='submaster')&&!sellerPermission.permissions?.canCreateSubmasters)
      error(403,'SUBMASTER_CREATION_FORBIDDEN','Você não pode criar novos revendedores de painel.');
    if(inviteType==='submaster'&&!catalog.can_resell_panel)
      error(422,'PLAN_NO_RESALE','Escolha um plano que autorize a revenda do painel.');
    const plan=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:planCode',{planCode},t);
    if(!plan||!plan.active)error(409,'PLAN_ADAPTER_MISSING','O plano original ainda não foi sincronizado. Execute a migração e salve o plano.');
    try{verifyPortalInviteInput({months,unitResaleCents,inviteType},plan);}catch{error(422,'PORTAL_INVITE_PRICE','Plano, duração ou preço inválido.');}
    if(!resaleAllowed(unitResaleCents,plan))error(422,'PORTAL_INVITE_PRICE','Preço abaixo do piso de revenda.');
    safeTotal(unitResaleCents,months);
    const snapshot=packageSnapshot(plan);
    if(!snapshot)error(409,'PACKAGE_NOT_CONFIGURED','Este plano ainda não foi sincronizado com o cadastro comercial. Solicite atualização do plano à DeltaTV.');
    let paymentGateway='manual';
    if(paymentMode==='gateway'){
      const seller=await one(`SELECT default_gateway,can_manage_gateways FROM partner_portal_sellers WHERE partner_id=:id`,{id:sellerPartnerId},t);
      const configured=await one(`SELECT 1 FROM partner_portal_seller_gateways WHERE partner_id=:id
        AND provider=:provider AND active=true`,{id:sellerPartnerId,provider:seller?.default_gateway},t);
      if(!seller?.can_manage_gateways||!configured)error(409,'SELLER_GATEWAY_UNAVAILABLE','Configure seu gateway de pagamento antes de gerar checkout.');
      paymentGateway=seller.default_gateway;
    }
    // Uma venda do PAINEL DO PARCEIRO não consome saldo de licenças ou meses.
    // Contratos antigos com stock_reserved=true continuam reconciliáveis.
    const invite=await one(`INSERT INTO partner_portal_sales_invitations
      (seller_partner_id,token_hash,invited_name,invited_email,invite_type,plan_code,months,
       unit_resale_cents,monthly_fee_cents,created_by,expires_at,package_snapshot,payment_gateway,payment_total_cents,stock_reserved)
      VALUES (:sellerPartnerId,:tokenHash,:invitedName,:email,:inviteType,:planCode,:months,
        :unitResaleCents,:monthlyFeeCents,:actorId,:expiresAt,CAST(:snapshot AS jsonb),:paymentGateway,:paymentTotal,false) RETURNING *`,
      {sellerPartnerId,tokenHash,invitedName:invitedName.trim(),email,inviteType,planCode,months,unitResaleCents,monthlyFeeCents,expiresAt,actorId:actor.id,snapshot:JSON.stringify(snapshot),paymentGateway,paymentTotal:safeTotal(unitResaleCents,months)},t);
    await audit({actor,action:'portal.sales.invitation.created',entityType:'partner_portal_sales_invitation',entityId:invite.id,
      metadata:{sellerPartnerId,email,inviteType,months,planCode,stockReserved:false,priceVerified:false},transaction:t});
    return invite;
  });
  let emailSent=false;
  let warning=null;
  let checkoutUrl=null;
  let pixCode=null;
  if(row.payment_gateway!=='manual'){
    try{
      const {createResaleCheckout}=await import('./resale-payments.service.js');
      const checkout=await createResaleCheckout(row.id,sellerPartnerId,{actor});
      checkoutUrl=checkout.checkout_url;
      pixCode=checkout.payment_pix_code;
    }catch(e){warning='Reserva criada, mas a cobrança não foi gerada. Gere o checkout na lista de convites; o cadastro não será ativado sem confirmação.';}
  }

  try{
    const {escapeMailHtml}=await import('../partners/partner-invite.policy.js');
    await sendMail({to:email,toName:invitedName,subject:'Delta TV — convite comercial para o Painel do Parceiro',
      text:`Olá, ${invitedName}!\n\nVocê recebeu um convite para acessar o Painel do Parceiro DeltaTV, com ${months} mês(es) de acesso contratado.\n\nConclua seu cadastro por este link (72 horas):\n${link}\n${checkoutUrl?'\nPagamento seguro: '+checkoutUrl+'\n':''}\nSe não solicitou, ignore.`,
      html:`<div style="font:16px Arial,sans-serif"><h2>Delta TV — Painel do Parceiro</h2><p>Olá, ${escapeMailHtml(invitedName)}!</p><p>Você recebeu um convite comercial para ${months} mês(es) de acesso.</p><p><a href="${escapeMailHtml(link)}">Concluir cadastro no Painel do Parceiro</a></p>${checkoutUrl?`<p><a href="${escapeMailHtml(checkoutUrl)}">Pagar acesso</a></p>`:''}<p>O convite expira em 72 horas.</p></div>`});
    emailSent=true;
  }catch(e){warning=[warning,'Convite criado, mas o e-mail não foi enviado. Copie o link e encaminhe ao cliente com segurança.'].filter(Boolean).join(' ');}
  // O link não fica salvo em texto puro: só é retornado nesta primeira resposta ao vendedor.
  return {id:row.id,invitedEmail:email,inviteType,planCode,months,expiresAt:row.expires_at,link,emailSent,warning,checkoutUrl,pixCode,paymentGateway:row.payment_gateway};
}
export async function revokeInvitation(sellerId,invitationId,actor){
  sellerActor(actor,sellerId);
  return tx(async t=>{
    const row=await one(`SELECT * FROM partner_portal_sales_invitations
      WHERE id=:invitationId AND seller_partner_id=:sellerId FOR UPDATE`,{invitationId,sellerId},t);
    if(!row)error(404,'INVITE_NOT_FOUND','Convite não encontrado na sua rede.');
    if(row.payment_status==='paid')error(409,'PAID_INVITE_NEEDS_REVIEW','Convite pago não pode ser cancelado sem conciliação e reembolso.');
    if(row.status!=='pending')error(409,'INVITE_FINALIZED','Convite já encerrado e não pode ser cancelado.');
    const released=await returnReservation(row,t,'revoked');
    await audit({actor,action:'portal.sales.invitation.revoked',entityType:'partner_portal_sales_invitation',entityId:row.id,
      metadata:{sellerId,monthsReturned:released?row.months:0,planCode:row.plan_code},transaction:t});
    return {ok:true,stockRestored:released&&!!row.stock_reserved};
  });
}
export async function verifyInvitation(token){
  if(!/^[A-Za-z0-9_-]{32,100}$/.test(String(token)))throw publicInvalid();
  const row=await one(`SELECT i.invited_name,i.invited_email,i.invite_type,i.plan_code,i.months,i.expires_at,
    i.payment_gateway,i.payment_status,i.payment_total_cents,i.checkout_url,i.payment_pix_code,
    p.name AS plan_name FROM partner_portal_sales_invitations i JOIN partner_portal_sales_plans p ON p.code=i.plan_code
    WHERE i.token_hash=:hash AND i.status='pending' AND i.expires_at>now()`,{hash:hashToken(token)});
  if(!row)throw publicInvalid();
  return {name:row.invited_name,email:row.invited_email,inviteType:row.invite_type,planName:row.plan_name,months:row.months,expiresAt:row.expires_at,paymentGateway:row.payment_gateway,paymentStatus:row.payment_status,checkoutUrl:row.checkout_url,pixCode:row.payment_pix_code,totalCents:row.payment_total_cents};
}
export async function completeInvitation({token,companyName,password}){
  if(!/^[A-Za-z0-9_-]{32,100}$/.test(String(token)))throw publicInvalid();
  // bcrypt/scrypt fora da transação de banco para manter locks curtos.
  const passwordHash=await hashPassword(password);
  return tx(async t=>{
    const row=await one(`SELECT * FROM partner_portal_sales_invitations WHERE token_hash=:hash FOR UPDATE`,{hash:hashToken(token)},t);
    if(!row||row.status!=='pending'||new Date(row.expires_at).getTime()<=Date.now())throw publicInvalid();
    await activeSeller(row.seller_partner_id,t);
    const permissions=await ownPermissions(row.seller_partner_id,t);
    if(!permissions.enabled||!permissions.permissions?.canSell)
      error(403,'PANEL_RESALE_REVOKED','O vendedor não possui mais permissão para concluir este convite.');
    if(!isPaidInviteReady(row))error(402,'PORTAL_PAYMENT_REQUIRED','O recebimento precisa ser confirmado antes da conclusão do cadastro.');
    await assertEmailAvailable(row.invited_email,t);
    const plan=await one('SELECT * FROM partner_portal_sales_plans WHERE code=:code',{code:row.plan_code},t);
    // Oferta já reservada pelo preço vigente na emissão: mudança posterior no piso/estado
    // comercial do plano NÃO invalida meses pré-pagos anteriormente comprometidos.
    if(!plan)error(409,'PORTAL_PLAN_NOT_FOUND','Plano comercial não encontrado.');
    const hiddenTier=await one('SELECT hidden_from_network FROM service_plan_catalogs WHERE key=:key',
      {key:plan.service_tier||row.plan_code},t);
    if(hiddenTier?.hidden_from_network)error(403,'PLAN_HIDDEN','Plano reservado à administração.');
    const now=new Date();
    const expiresAt=addMonthsUtc(now,row.months);
    const slug=`parceiro-${crypto.randomBytes(7).toString('hex')}`;
    const partner=await Partner.create({name:companyName.trim(),slug,contactName:row.invited_name,
      contactEmail:row.invited_email,kind:'content',billingModel:'none',status:'active',startsAt:now,endsAt:expiresAt}, {transaction:t});
    const user=await AdminUser.create({name:row.invited_name,email:row.invited_email,passwordHash,role:'partner',
      partnerId:partner.id,status:'active'}, {transaction:t});
    // Every new paid account receives the technical benefits of the purchased package.
    // Older invitations with no snapshot remain legacy and do NOT change behavior.
    const snapshot=row.package_snapshot;
    if(snapshot){
      await applyServicePackageToPartner(partner.id,snapshot,t,{recordAssignment:false});
    }
    // The ORIGINAL plan determines resale rights. The child's delegated rights
    // cannot exceed its selling parent's effective permissions.
    const childPlan=snapshot?.tier?await one(`SELECT can_resell_panel,can_create_submasters,
      can_view_finance,can_manage_gateways FROM service_plan_catalogs WHERE key=:tier`,
      {tier:snapshot.tier},t):null;
    // Existing, previously-issued invitations without a snapshot retain the
    // invitation role for backward compatibility; new invitations use plan rights.
    if(childPlan?.can_resell_panel||(!snapshot&&row.invite_type==='submaster')){
      await run(`INSERT INTO partner_portal_sellers(partner_id,parent_partner_id,role,can_sell,active,
        can_create_submasters,can_view_finance,can_manage_gateways)
        VALUES (:partnerId,:sellerPartnerId,'submaster',true,true,:canCreate,:canFinance,:canGateway)`,
        {partnerId:partner.id,sellerPartnerId:row.seller_partner_id,
          canCreate:!!(childPlan?.can_create_submasters&&permissions.permissions.canCreateSubmasters),
          canFinance:!!(childPlan?.can_view_finance&&permissions.permissions.canViewFinance),
          canGateway:!!(childPlan?.can_manage_gateways&&permissions.permissions.canManageGateways)},t);
    }
    const contract=await one(`INSERT INTO partner_portal_access_contracts
      (customer_partner_id,seller_partner_id,plan_code,start_at,expires_at,months_paid,declared_resale_cents,monthly_fee_cents,package_snapshot)
      VALUES(:partnerId,:sellerPartnerId,:planCode,:now,:expiresAt,:months,:declaredTotal,:monthlyFeeCents,CAST(:snapshot AS jsonb)) RETURNING *`,
      {partnerId:partner.id,sellerPartnerId:row.seller_partner_id,planCode:row.plan_code,now,expiresAt,months:row.months,
        declaredTotal:safeTotal(Number(row.unit_resale_cents),row.months),monthlyFeeCents:Number(row.monthly_fee_cents),snapshot:JSON.stringify(snapshot||null)},t);
    await run(`INSERT INTO partner_portal_contract_events
      (contract_id,seller_partner_id,request_id,months,plan_code,declared_resale_cents,expires_at,actor_user_id)
      VALUES (:contractId,:sellerPartnerId,:requestId,:months,:planCode,:declaredTotal,:expiresAt,:actorId)`,
      {contractId:contract.id,sellerPartnerId:row.seller_partner_id,requestId:row.id,months:row.months,
        planCode:row.plan_code,declaredTotal:safeTotal(Number(row.unit_resale_cents),row.months),expiresAt,actorId:row.created_by},t);
    await run(`UPDATE partner_portal_sales_invitations SET status='accepted',token_hash=:consumedHash,
      accepted_partner_id=:partnerId,accepted_at=now(),updated_at=now() WHERE id=:id`,
      {id:row.id,consumedHash:hashToken(`consumed:${row.id}:${crypto.randomBytes(12).toString('hex')}`),partnerId:partner.id},t);
    await audit({actor:{type:'anonymous',id:null},action:'portal.sales.invitation.accepted',entityType:'partner',entityId:partner.id,
      metadata:{invitationId:row.id,sellerId:row.seller_partner_id,contractId:contract.id,
        planCode:row.plan_code,months:row.months,inviteType:row.invite_type,createdUserId:user.id,stockAlreadyReserved:!!row.stock_reserved},transaction:t});
    if(snapshot)invalidatePlan(partner.id);
    return {ok:true,message:'Cadastro concluído. Entre no Painel do Parceiro com seu e-mail e senha.',partnerId:partner.id};
  });
}

/** Supervisão global: somente Superadmin visualiza/encerra convites de qualquer ramo. */
export async function adminInvitations(actor){
  if(actor?.role!=='superadmin'||actor?.type!=='admin')error(403,'SUPERADMIN_ONLY','Operação exclusiva do Superadmin.');
  return read(`SELECT i.id,i.seller_partner_id,p.name AS seller_name,i.invited_name,i.invited_email,
    i.invite_type,i.plan_code,i.months,i.status,i.expires_at,i.created_at,i.accepted_partner_id
    FROM partner_portal_sales_invitations i JOIN partners p ON p.id=i.seller_partner_id
    ORDER BY i.created_at DESC LIMIT 200`);
}
export async function adminRevokeInvitation(invitationId,actor){
  if(actor?.role!=='superadmin'||actor?.type!=='admin')error(403,'SUPERADMIN_ONLY','Operação exclusiva do Superadmin.');
  return tx(async t=>{
    const row=await one('SELECT * FROM partner_portal_sales_invitations WHERE id=:invitationId FOR UPDATE',{invitationId},t);
    if(!row)error(404,'INVITE_NOT_FOUND','Convite comercial não encontrado.');
    if(row.payment_status==='paid')error(409,'PAID_INVITE_NEEDS_REVIEW','Convite pago não pode ser cancelado sem conciliação e reembolso.');
    if(row.status!=='pending')error(409,'INVITE_FINALIZED','Não é possível revogar convite já encerrado.');
    const released=await returnReservation(row,t,'revoked');
    await audit({actor,action:'portal.sales.invitation.admin_revoked',entityType:'partner_portal_sales_invitation',entityId:row.id,
      metadata:{sellerId:row.seller_partner_id,monthsReturned:released?row.months:0,planCode:row.plan_code},transaction:t});
    return {ok:true,stockRestored:released&&!!row.stock_reserved};
  });
}

/** Rotina idempotente de liberação de reservas vencidas. Requer o scheduler ativo;
 * a consulta do distribuidor também executa a liberação sob lock como fallback.
 */
export async function sweepExpiredCommercialInvites(batchSize=300){
  const limit=Math.max(1,Math.min(1000,Number(batchSize)||300));
  return tx(async t=>{
    const pending=await read(`SELECT * FROM partner_portal_sales_invitations
      WHERE status='pending' AND expires_at<=now() ORDER BY expires_at ASC LIMIT :limit FOR UPDATE`,{limit},t);
    let expired=0;
    for(const row of pending)if(await returnReservation(row,t,'expired'))expired++;
    return {expired,morePossible:expired>=limit};
  });
}
export async function reclaimCommercialSellerInvites(sellerId){
  return tx(async t=>reclaimExpired(sellerId,t));
}
