import {Router} from 'express';
import {z} from 'zod';
import {validate} from '../../shared/validate.js';
import {actorOf} from '../../shared/audit.js';
import {AppError} from '../../shared/errors.js';
import * as svc from './sales.service.js';
import * as invitations from './invitations.service.js';
import * as checkout from './checkout.service.js';
import {PORTAL_PAYMENT_GATEWAYS} from './checkout.rules.js';
import {webhookLimiter,pixCreateLimiter} from '../../middleware/security.js';
import {adminPortalUsage,partnerPortalUsage} from '../partner-portal-usage/usage.routes.js';
import {stockWriteLimiter,loginLimiter,signupLimiter} from '../../middleware/security.js';

const noStore=(_req,res,next)=>{res.set('Cache-Control','no-store');next();};
const uuid=z.string().uuid();
const cents=z.number().int().min(0).max(1_000_000_000);
const qty=z.number().int().min(1).max(100_000); // Proteção por requisição, não quota comercial.
const actionId=z.object({id:uuid}).strict();
const stockOrder=z.object({sellerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty}).strict();
const assignment=z.object({sellerPartnerId:uuid,customerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),months:z.number().int().min(1).max(120),unitResaleCents:cents,monthlyFeeCents:cents.default(0),requestId:uuid}).strict();
const transfer=z.object({buyerPartnerId:uuid,planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),quantityMonths:qty,unitResaleCents:cents,requestId:uuid}).strict();
const adminOnly=(req,_res,next)=>{if(req.user?.role!=='superadmin'||req.impersonator)throw new AppError(403,'SUPERADMIN_ONLY','Somente o Superadmin administra o comércio do Painel do Parceiro.');next();};

export const adminPortalSales=Router();
adminPortalSales.use(adminOnly,noStore);
adminPortalSales.use('/usage',adminPortalUsage);
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
partnerPortalSales.get('/',async(req,res)=>res.json(await svc.sellerOverview(req.user.partnerId)));
partnerPortalSales.get('/orders/:id',validate({params:actionId}),async(req,res)=>
 res.json(await checkout.orderFor(req.valid.params.id,{sellerId:req.user.partnerId})));
partnerPortalSales.post('/orders/:id/checkout',pixCreateLimiter,validate({params:actionId}),async(req,res)=>
 res.json(await checkout.createCheckout(req.valid.params.id,{sellerId:req.user.partnerId,actor:actorOf(req)})));
partnerPortalSales.post('/orders/:id/confirm-return',pixCreateLimiter,validate({params:actionId,
 body:z.object({transactionNsu:z.string().trim().min(8).max(160),slug:z.string().trim().min(2).max(160)}).strict()}),async(req,res)=>
 res.json(await checkout.confirmReturn(req.valid.params.id,req.user.partnerId,req.valid.body)));
partnerPortalSales.post('/transfers',validate({body:transfer}),async(req,res)=>res.status(201).json(await svc.transfer({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));
partnerPortalSales.post('/renewals',validate({body:assignment.omit({sellerPartnerId:true})}),async(req,res)=>res.status(201).json(await svc.assignAccess({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));

// Convites comerciais pagam o PAINEL DO PARCEIRO; nunca criam licenças de TV.
const inviteBody=z.object({
  invitedName:z.string().trim().min(2).max(160),invitedEmail:z.string().trim().email().max(200),
  inviteType:z.enum(['customer','submaster']),planCode:z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  months:z.number().int().min(1).max(120),unitResaleCents:cents,monthlyFeeCents:cents.default(0),
}).strict();
partnerPortalSales.get('/tree',async(req,res)=>res.json({items:await svc.portalSalesTree({sellerPartnerId:req.user.partnerId,actor:actorOf(req)})}));
partnerPortalSales.get('/invitations',async(req,res)=>res.json({items:await invitations.listInvitations(req.user.partnerId,actorOf(req))}));
partnerPortalSales.post('/invitations',stockWriteLimiter,validate({body:inviteBody}),async(req,res)=>
  res.status(201).json(await invitations.createInvitation({...req.valid.body,sellerPartnerId:req.user.partnerId},actorOf(req))));
partnerPortalSales.post('/invitations/:id/revoke',stockWriteLimiter,validate({params:actionId}),async(req,res)=>
  res.json(await invitations.revokeInvitation(req.user.partnerId,req.valid.params.id,actorOf(req))));

// Rota pública: token SOMENTE em POST body. Controle de frequência e sem cookies de sessão.
export const publicPortalSalesInvitations=Router();
publicPortalSalesInvitations.use(noStore);
const invitationToken=z.string().min(32).max(100).regex(/^[A-Za-z0-9_-]+$/);
publicPortalSalesInvitations.post('/verify',loginLimiter,validate({body:z.object({token:invitationToken}).strict()}),
  async(req,res)=>res.json(await invitations.verifyInvitation(req.valid.body.token)));
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
