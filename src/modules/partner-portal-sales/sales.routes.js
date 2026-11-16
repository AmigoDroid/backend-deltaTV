import {Router} from 'express';
import {z} from 'zod';
import {validate} from '../../shared/validate.js';
import {actorOf} from '../../shared/audit.js';
import {AppError} from '../../shared/errors.js';
import * as svc from './sales.service.js';
import * as invitations from './invitations.service.js';
import * as checkout from './checkout.service.js';
import * as v2 from './commercial-v2.service.js';
import * as support from './support-v2.service.js';
import * as resale from './resale-payments.service.js';
import {PERMISSION_KEYS} from './commercial-v2.rules.js';
import {PORTAL_PAYMENT_GATEWAYS} from './checkout.rules.js';
import {webhookLimiter,pixCreateLimiter} from '../../middleware/security.js';
import {adminPortalUsage,partnerPortalUsage} from '../partner-portal-usage/usage.routes.js';
import {stockWriteLimiter,loginLimiter,signupLimiter} from '../../middleware/security.js';

const noStore=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
const uuid=z.string().uuid();
const cents=z.number().int().min(0).max(1_000_000_000);
const qty=z.number().int().min(1).max(100_000); // Proteção por requisição, não quota comercial.
const actionId=z.object({id:uuid}).strict();
const packageCode=z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/);
const packageBody=z.object({code:packageCode,name:z.string().trim().min(2).max(120),tier:packageCode,
  wholesaleCents:cents.min(1),minResaleCents:cents.min(1),active:z.boolean().default(true),
  maxDns:z.number().int().min(1).max(2_000_000).nullable(),
  activationLimit:z.number().int().min(0).max(2_000_000_000).nullable(),
  autoFailover:z.boolean(),autoPriority:z.boolean(),emailAlerts:z.boolean(),detailedHistory:z.boolean()}).strict();
const permissionsBody=z.object(Object.fromEntries(PERMISSION_KEYS.map(k=>[k,z.boolean().optional()])))
 .strict().refine(x=>Object.keys(x).length>0);
const transferRequest=z.object({subjectId:uuid,destinationId:uuid}).strict();
const supportOpen=z.object({subject:z.string().trim().min(4).max(160),category:z.enum(['technical','dns','activations','billing','network','other']),
  priority:z.enum(['normal','high','urgent']).default('normal'),destination:z.enum(['deltatv','master']),
  message:z.string().trim().min(5).max(8000)}).strict();
const supportReply=z.object({body:z.string().trim().min(1).max(8000),internal:z.boolean().default(false),
  status:z.enum(['open','in_progress','waiting','resolved']).optional()}).strict();

const stockOrder=z.object({sellerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty}).strict();
const assignment=z.object({sellerPartnerId:uuid,customerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),months:z.number().int().min(1).max(120),unitResaleCents:cents,monthlyFeeCents:cents.default(0),requestId:uuid}).strict();
const transfer=z.object({buyerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty,unitResaleCents:cents,requestId:uuid}).strict();
const adminOnly=(req,_res,next)=>{if(req.user?.role!=='superadmin'||req.impersonator)throw new AppError(403,'SUPERADMIN_ONLY','Somente o Superadmin administra o comércio do Painel do Parceiro.');next();};

export const adminPortalSales=Router();
adminPortalSales.use(adminOnly,noStore);
adminPortalSales.use('/usage',adminPortalUsage);
// The new storefront uses a single Service Package for contract + technical benefits.
// Historical /plans and /orders routes remain mounted for reconciliations and old bookmarks.
adminPortalSales.get('/packages',async(_req,res)=>res.json({items:await v2.packages()}));
adminPortalSales.put('/packages',validate({body:packageBody}),async(req,res)=>res.json(await v2.saveServicePackage(req.valid.body,actorOf(req))));
adminPortalSales.get('/receivables',async(_req,res)=>res.json({items:await v2.adminReceivables()}));
adminPortalSales.get('/negotiated-prices',async(_req,res)=>res.json({items:await v2.agreedMasterPrices()}));
adminPortalSales.post('/masters/onboard',stockWriteLimiter,validate({body:z.object({partnerId:uuid,planCode:packageCode,
  quantityMonths:z.number().int().min(1).max(100000),agreedPriceCents:cents.min(1),monthlyFeeCents:cents.default(0),
  paymentMode:z.enum(['default','manual']).default('default')}).strict()}),
 async(req,res)=>res.status(201).json(await v2.onboardRootMaster(req.valid.body,actorOf(req))));
// Cadastro compacto. Conta + pacote + limite + permissões, com cobrança opcional.
const masterAccount=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('existing'),partnerId:uuid}).strict(),
 z.object({mode:z.literal('new'),companyName:z.string().trim().min(2).max(160),name:z.string().trim().min(2).max(160),
  email:z.string().trim().email().max(200),password:z.string().min(10).max(128)}).strict()
]);
adminPortalSales.post('/masters/quick',stockWriteLimiter,validate({body:z.object({
 account:masterAccount,planCode:packageCode,activationLimit:z.number().int().min(0).max(2_000_000_000).nullable(),
 permissions:z.object(Object.fromEntries(PERMISSION_KEYS.map(k=>[k,z.boolean()]))).strict(),
 free:z.boolean(),quantityMonths:z.number().int().min(1).max(120).default(12),
 agreedPriceCents:cents.optional(),paymentMode:z.enum(['default','manual']).default('default')
}).strict()}),async(req,res)=>res.status(201).json(await v2.onboardMasterSimple(req.valid.body,actorOf(req))));
adminPortalSales.put('/negotiated-prices',validate({body:z.object({sellerId:uuid,planCode:packageCode,unitPriceCents:cents.min(1),reason:z.string().trim().min(8).max(500)}).strict()}),async(req,res)=>res.json(await v2.setAgreedMasterPrice(req.valid.body,actorOf(req))));
adminPortalSales.get('/reparent-requests',async(_req,res)=>res.json({items:await v2.reparentRequests(null,{isAdmin:true})}));
adminPortalSales.patch('/sellers/:id/permissions',validate({params:actionId,body:permissionsBody}),async(req,res)=>
 res.json(await v2.updateChildPermissions({childId:req.valid.params.id,input:req.valid.body,actor:actorOf(req),isAdmin:true})));
adminPortalSales.get('/support/tickets',async(req,res)=>res.json({items:await support.ticketsFor(actorOf(req))}));
adminPortalSales.get('/support/tickets/:id',validate({params:actionId}),async(req,res)=>res.json(await support.ticketDetail(req.valid.params.id,actorOf(req))));
adminPortalSales.post('/support/tickets/:id/reply',validate({params:actionId,body:supportReply}),async(req,res)=>
 res.json(await support.replyTicket(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.post('/support/tickets/:id/assign',validate({params:actionId,body:z.object({destinationId:uuid.nullable()}).strict()}),async(req,res)=>
 res.json(await support.assignTicket(req.valid.params.id,req.valid.body.destinationId,actorOf(req))));

adminPortalSales.get('/',async(_req,res)=>res.json(await svc.adminOverview()));
adminPortalSales.put('/costs',validate({body:z.object({vpsMonthlyCents:cents,domainAnnualCents:cents,otherMonthlyCents:cents,proxyCostPerGbCents:cents,forecastProxyGbPerPartner:z.number().int().min(0).max(1000000),targetMarginBp:z.number().int().min(0).max(8000),taxBp:z.number().int().min(0).max(2500),reserveBp:z.number().int().min(0).max(6000)}).strict().refine(x=>x.targetMarginBp+x.taxBp<9000)}),async(req,res)=>res.json(await svc.updateCosts(req.valid.body,actorOf(req))));
adminPortalSales.get('/tree',async(req,res)=>res.json({items:await svc.portalSalesTree({actor:actorOf(req)})}));
adminPortalSales.get('/invitations',async(req,res)=>res.json({items:await invitations.adminInvitations(actorOf(req))}));
adminPortalSales.post('/invitations/:id/revoke',validate({params:actionId}),async(req,res)=>res.json(await invitations.adminRevokeInvitation(req.valid.params.id,actorOf(req))));
// Credenciais exclusivamente no .env do backend. A escolha do padrão fica no banco.
adminPortalSales.get('/payment-settings',async(_req,res)=>res.json(await checkout.paymentSettings()));
adminPortalSales.put('/payment-settings',validate({body:z.object({defaultGateway:z.enum(PORTAL_PAYMENT_GATEWAYS)}).strict()}),
  async(req,res)=>res.json(await checkout.setDefaultGateway(req.valid.body.defaultGateway,actorOf(req))));
adminPortalSales.post('/orders/:id/checkout',pixCreateLimiter,validate({params:actionId}),
  async(req,res)=>res.json(await checkout.createCheckout(req.valid.params.id,{actor:actorOf(req)})));
adminPortalSales.post('/orders/:id/infinitepay/verify',pixCreateLimiter,validate({params:actionId,
 body:z.object({transactionNsu:z.string().trim().min(8).max(160),slug:z.string().trim().min(2).max(160)}).strict()}),
 async(req,res)=>res.json(await checkout.verifyInfinitePayAdmin(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.post('/orders/:id/recheck',pixCreateLimiter,validate({params:actionId}),
  async(req,res)=>res.json(await checkout.checkOrder(req.valid.params.id,actorOf(req))));
adminPortalSales.get('/candidates',validate({query:z.object({q:z.string().trim().max(80).default('')})}),async(req,res)=>res.json(await svc.adminCandidates(req.valid.query.q)));
adminPortalSales.post('/sellers',validate({body:z.object({partnerId:uuid,parentPartnerId:uuid.nullable().optional()}).strict()}),async(req,res)=>res.status(201).json(await svc.registerSeller(req.valid.body,actorOf(req))));
adminPortalSales.patch('/sellers/:id',validate({params:actionId,body:z.object({active:z.boolean().optional(),canSell:z.boolean().optional()}).strict().refine(x=>Object.keys(x).length>0)}),async(req,res)=>res.json(await svc.setSellerState(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.put('/plans',validate({body:z.object({code:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),name:z.string().trim().min(2).max(120),wholesaleCents:cents.min(1),minResaleCents:cents.min(1),active:z.boolean().default(true)}).strict()}),async(req,res)=>res.json(await svc.savePlan(req.valid.body,actorOf(req))));
adminPortalSales.post('/orders',validate({body:stockOrder}),async(req,res)=>res.status(201).json(await svc.createStockOrder(req.valid.body,actorOf(req))));
adminPortalSales.post('/orders/:id/settle',validate({params:actionId,body:z.object({settlementRef:z.string().trim().min(6).max(120),method:z.enum(['pix_manual_confirmed','bank_manual_confirmed','cash_manual_confirmed'])}).strict()}),async(req,res)=>res.json(await svc.settleStockOrder(req.valid.params.id,req.valid.body,actorOf(req))));
adminPortalSales.post('/exceptions',validate({body:z.object({sellerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty,reason:z.string().trim().min(10).max(500)}).strict()}),async(req,res)=>res.status(201).json(await svc.grantException(req.valid.body,actorOf(req))));
adminPortalSales.post('/contracts',validate({body:assignment}),async(req,res)=>res.status(201).json(await svc.assignAccess(req.valid.body,actorOf(req),{admin:true})));

export const partnerPortalSales=Router();
partnerPortalSales.use(noStore);
partnerPortalSales.use('/usage',partnerPortalUsage);
partnerPortalSales.get('/my-package',async(req,res)=>res.json(await v2.myPackage(req.user.partnerId)));
partnerPortalSales.get('/permissions',async(req,res)=>res.json(await v2.ownPermissions(req.user.partnerId)));
partnerPortalSales.patch('/submasters/:id/permissions',validate({params:actionId,body:permissionsBody}),async(req,res)=>
 res.json(await v2.updateChildPermissions({parentId:req.user.partnerId,childId:req.valid.params.id,input:req.valid.body,actor:actorOf(req)})));
partnerPortalSales.post('/reparent-code',stockWriteLimiter,async(req,res)=>res.status(201).json(await v2.createReparentCode(actorOf(req))));
partnerPortalSales.post('/reparent-requests/code',stockWriteLimiter,validate({body:z.object({code:z.string().trim().min(20).max(100)}).strict()}),async(req,res)=>res.status(201).json(await v2.requestReparentByCode(req.valid.body.code,actorOf(req))));
partnerPortalSales.get('/reparent-requests',async(req,res)=>res.json({items:await v2.reparentRequests(req.user.partnerId)}));
partnerPortalSales.post('/reparent-requests',validate({body:transferRequest}),async(req,res)=>res.status(201).json(await v2.requestReparent({...req.valid.body,actor:actorOf(req)})));
partnerPortalSales.post('/reparent-requests/:id/decision',validate({params:actionId,body:z.object({accept:z.boolean()}).strict()}),async(req,res)=>
 res.json(await v2.decideReparent(req.valid.params.id,req.valid.body.accept,actorOf(req))));
partnerPortalSales.get('/gateways',async(req,res)=>res.json(await v2.sellerGatewayStatus(req.user.partnerId)));
partnerPortalSales.put('/gateways',validate({body:z.object({provider:z.enum(['mercadopago','infinitepay']),accessToken:z.string().trim().min(12).max(1000),
  handle:z.string().trim().max(120).optional(),webhookSecret:z.string().max(300).optional(),currentPassword:z.string().min(1).max(128)}).strict()}),async(req,res)=>
 res.json(await v2.saveSellerGateway(req.user.partnerId,req.valid.body,actorOf(req))));
partnerPortalSales.put('/gateways/default',validate({body:z.object({provider:z.enum(['mercadopago','infinitepay'])}).strict()}),async(req,res)=>
 res.json(await v2.setSellerDefaultGateway(req.user.partnerId,req.valid.body.provider,actorOf(req))));
partnerPortalSales.get('/support/tickets',async(req,res)=>res.json({items:await support.ticketsFor(actorOf(req))}));
partnerPortalSales.post('/support/tickets',validate({body:supportOpen}),async(req,res)=>res.status(201).json(await support.openTicket(req.valid.body,actorOf(req))));
partnerPortalSales.get('/support/tickets/:id',validate({params:actionId}),async(req,res)=>res.json(await support.ticketDetail(req.valid.params.id,actorOf(req))));
partnerPortalSales.post('/support/tickets/:id/reply',validate({params:actionId,body:supportReply}),async(req,res)=>
 res.json(await support.replyTicket(req.valid.params.id,req.valid.body,actorOf(req))));

// O Master recém-cadastrado pode pagar o próprio acesso sem permissão de revenda.
partnerPortalSales.post('/my-package/checkout',pixCreateLimiter,async(req,res)=>{
 const id=await v2.pendingMasterOrderId(req.user.partnerId);
 return res.json(await checkout.createCheckout(id,{sellerId:req.user.partnerId,actor:actorOf(req)}));
});
partnerPortalSales.get('/eligibility',async(req,res)=>res.json(await svc.sellerEligibility(req.user.partnerId)));
partnerPortalSales.get('/',async(req,res)=>res.json(await svc.sellerOverview(req.user.partnerId)));
const allowFinancialActions=async(req,_res,next)=>{const state=await v2.ownPermissions(req.user.partnerId);
 if(!state.enabled||!state.permissions?.canViewFinance)throw new AppError(403,'FINANCE_PERMISSION_REQUIRED','Sua conta não possui permissão financeira.');next();};
partnerPortalSales.get('/orders/:id',allowFinancialActions,validate({params:actionId}),async(req,res)=>
 res.json(await checkout.orderFor(req.valid.params.id,{sellerId:req.user.partnerId})));
partnerPortalSales.post('/orders/:id/checkout',allowFinancialActions,pixCreateLimiter,validate({params:actionId}),async(req,res)=>
 res.json(await checkout.createCheckout(req.valid.params.id,{sellerId:req.user.partnerId,actor:actorOf(req)})));
partnerPortalSales.post('/orders/:id/confirm-return',allowFinancialActions,pixCreateLimiter,validate({params:actionId,
 body:z.object({transactionNsu:z.string().trim().min(8).max(160),slug:z.string().trim().min(2).max(160)}).strict()}),async(req,res)=>
 res.json(await checkout.confirmReturn(req.valid.params.id,req.user.partnerId,req.valid.body)));
partnerPortalSales.post('/orders/:id/payment-method',allowFinancialActions,validate({params:actionId,body:z.object({mode:z.enum(['manual','default'])}).strict()}),async(req,res)=>
 res.json(await checkout.chooseStockOrderPaymentMethod(req.valid.params.id,req.user.partnerId,req.valid.body.mode,actorOf(req))));
partnerPortalSales.post('/transfers',validate({body:transfer}),async(req,res)=>res.status(201).json(await svc.transfer({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));
partnerPortalSales.post('/renewals',validate({body:assignment.omit({sellerPartnerId:true})}),async(req,res)=>res.status(201).json(await svc.assignAccess({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));

// Convites comerciais pagam o PAINEL DO PARCEIRO; nunca criam licenças de TV.
const inviteBody=z.object({
  invitedName:z.string().trim().min(2).max(160),invitedEmail:z.string().trim().email().max(200),
  inviteType:z.enum(['customer','submaster']),planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  months:z.number().int().min(1).max(120),unitResaleCents:cents,monthlyFeeCents:cents.default(0),
  paymentMode:z.enum(['manual','gateway']).default('manual'),
}).strict();
partnerPortalSales.get('/tree',async(req,res)=>res.json({items:await svc.portalSalesTree({sellerPartnerId:req.user.partnerId,actor:actorOf(req)})}));
partnerPortalSales.get('/invitations',async(req,res)=>res.json({items:await invitations.listInvitations(req.user.partnerId,actorOf(req))}));
partnerPortalSales.post('/invitations',stockWriteLimiter,validate({body:inviteBody}),async(req,res)=>
  res.status(201).json(await invitations.createInvitation({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));
partnerPortalSales.post('/invitations/:id/revoke',stockWriteLimiter,validate({params:actionId}),async(req,res)=>
  res.json(await invitations.revokeInvitation(req.user.partnerId,req.valid.params.id,actorOf(req))));
partnerPortalSales.post('/invitations/:id/checkout',pixCreateLimiter,validate({params:actionId}),async(req,res)=>
  res.json(await resale.createResaleCheckout(req.valid.params.id,req.user.partnerId,{actor:actorOf(req)})));
partnerPortalSales.post('/invitations/:id/confirm-external',stockWriteLimiter,validate({params:actionId,body:z.object({
  reference:z.string().trim().min(6).max(120),currentPassword:z.string().min(1).max(128),confirmReceived:z.literal(true)
}).strict()}),async(req,res)=>res.json(await resale.confirmManualResalePayment(
  req.valid.params.id,req.user.partnerId,req.valid.body,actorOf(req))));
partnerPortalSales.post('/invitations/:id/recheck',pixCreateLimiter,validate({params:actionId,body:z.object({
  transactionNsu:z.string().max(160).optional(),slug:z.string().max(160).optional()}).strict()}),async(req,res)=>
  res.json(await resale.recheckResaleCheckout(req.valid.params.id,req.user.partnerId,{actor:actorOf(req),...req.valid.body})));

// Rota pública: token SOMENTE em POST body. Controle de frequência e sem cookies de sessão.
export const publicPortalSalesInvitations=Router();
publicPortalSalesInvitations.use(noStore);
const invitationToken=z.string().min(32).max(100).regex(/^[A-Za-z0-9_-]+$/);
publicPortalSalesInvitations.post('/verify',loginLimiter,validate({body:z.object({token:invitationToken}).strict()}),
  async(req,res)=>res.json(await invitations.verifyInvitation(req.valid.body.token)));
publicPortalSalesInvitations.post('/recheck',loginLimiter,validate({body:z.object({token:invitationToken,transactionNsu:z.string().max(160).optional(),slug:z.string().max(160).optional()}).strict()}),
  async(req,res)=>res.json(await resale.publicRecheckResaleInvite(req.valid.body.token,req.valid.body)));
publicPortalSalesInvitations.post('/complete',signupLimiter,validate({body:z.object({
  token:invitationToken,companyName:z.string().trim().min(2).max(160),password:z.string().min(12).max(128),
}).strict()}),async(req,res)=>res.status(201).json(await invitations.completeInvitation(req.valid.body)));

// Webhook de cobrança do PAINEL DO PARCEIRO: rotas públicas, separadas da rede de TV.
export const portalSalesWebhook=Router();
portalSalesWebhook.use(noStore);
portalSalesWebhook.post('/infinitepay',webhookLimiter,async(req,res)=>
  res.json(await checkout.handleInfinitePayWebhook(req.body)));
portalSalesWebhook.post('/mercadopago',webhookLimiter,async(req,res)=>
  res.json(await checkout.handleMercadoPagoWebhook(req)));

// Rotas por vendedor: a credencial utilizada pertence exclusivamente à conta recebedora.
portalSalesWebhook.post('/resale/infinitepay/:sellerId',webhookLimiter,validate({params:z.object({sellerId:uuid})}),async(req,res)=>
 res.json(await resale.handleResaleInfinitePayWebhook(req.valid.params.sellerId,req.body)));
portalSalesWebhook.post('/resale/mercadopago/:sellerId',webhookLimiter,validate({params:z.object({sellerId:uuid})}),async(req,res)=>
 res.json(await resale.handleResaleMercadoPagoWebhook(req.valid.params.sellerId,req)));
