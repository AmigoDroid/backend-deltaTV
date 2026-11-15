import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { actorOf } from '../../shared/audit.js';
import { requirePermission } from '../../middleware/authenticate.js';
import { pixCreateLimiter, pixReadLimiter, stockWriteLimiter, webhookLimiter, profileSensitiveLimiter } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import * as svc from './master-pix.service.js';
import * as settings from './gateway-settings.service.js';
import * as gateways from './gateway-orders.service.js';
import { GATEWAY_PROVIDERS } from './gateways/index.js';
import { KEY_TYPES } from './gateways/brcode.js';

const uuid=z.string().uuid();
const params=z.object({id:uuid});
const price=z.object({months:z.number().int().min(1).max(120),unitPriceCents:z.number().int().positive().safe(),active:z.boolean().default(true)}).strict();
const accountBody=z.object({
  accessToken:z.string().trim().min(30).max(4096),
  webhookSecret:z.string().trim().min(16).max(512),
  currentPassword:z.string().min(8).max(128),
  active:z.boolean().default(true),
}).strict();
const providerParam=z.object({provider:z.enum(GATEWAY_PROVIDERS)});
const password=z.string().min(8).max(128);
const infinitePayBody=z.object({handle:z.string().trim().min(2).max(41),apiKey:z.string().trim().max(256).optional(),currentPassword:password,active:z.boolean().default(true)}).strict();
const manualPixBody=z.object({keyType:z.enum(KEY_TYPES),key:z.string().trim().min(3).max(120),receiverName:z.string().trim().min(2).max(25),
  receiverCity:z.string().trim().min(2).max(15),currentPassword:password,active:z.boolean().default(true)}).strict();
const returnBody=z.object({transactionNsu:z.string().trim().min(8).max(80),slug:z.string().trim().min(2).max(80)}).strict();
const orderBody=z.object({months:z.number().int().min(1).max(120),quantity:z.number().int().min(1).max(2_147_483_647),
  provider:z.enum(GATEWAY_PROVIDERS).default('mercadopago'),
  expectedUnitPriceCents:z.number().int().positive().safe(),idempotencyKey:uuid,
  document:z.string().regex(/^(\d{11}|\d{14})$/).optional(),
}).strict();
const noStore=(req,res,next)=>{res.set('Cache-Control','no-store');next();};

export const partnerMasterPixRouter=Router();
partnerMasterPixRouter.use(noStore);
const self=req=>req.user.partnerId;
partnerMasterPixRouter.get('/settings', async(req,res)=>res.json(await svc.mySettings(self(req))));
partnerMasterPixRouter.put('/settings',profileSensitiveLimiter,validate({body:accountBody}),async(req,res)=>
  res.json(await svc.saveSettings(self(req),req.valid.body,actorOf(req))));
partnerMasterPixRouter.patch('/settings',stockWriteLimiter,validate({body:z.object({active:z.boolean()}).strict()}),async(req,res)=>
  res.json(await svc.setActive(self(req),req.valid.body.active,actorOf(req))));
partnerMasterPixRouter.get('/prices',async(req,res)=>res.json({data:await svc.listOwnPrices(self(req))}));
partnerMasterPixRouter.put('/prices',stockWriteLimiter,validate({body:price}),async(req,res)=>
  res.json(await svc.savePrice(self(req),req.valid.body,actorOf(req))));
partnerMasterPixRouter.get('/offers',async(req,res)=>res.json(await svc.offersForBuyer(self(req))));
partnerMasterPixRouter.post('/orders',pixCreateLimiter,validate({body:orderBody}),async(req,res)=>
  res.status(201).json(await svc.startOrder(self(req),req.valid.body,actorOf(req))));
partnerMasterPixRouter.get('/orders',pixReadLimiter,async(req,res)=>res.json({data:await svc.ordersFor(self(req))}));
partnerMasterPixRouter.get('/sales',pixReadLimiter,async(req,res)=>res.json({data:await svc.ordersFor(self(req),'seller')}));
partnerMasterPixRouter.get('/network-sales',pixReadLimiter,async(req,res)=>res.json(await svc.subtreeReport(self(req))));
partnerMasterPixRouter.get('/orders/:id',pixReadLimiter,validate({params}),async(req,res)=>
  res.json(await svc.orderForBuyer(self(req),req.valid.params.id)));

// ---- Meios de recebimento do próprio vendedor (Mercado Pago, InfinitePay, Pix com chave própria) ----
partnerMasterPixRouter.get('/gateways',async(req,res)=>res.json({data:await settings.listGateways(self(req))}));
partnerMasterPixRouter.put('/gateways/infinitepay',profileSensitiveLimiter,validate({body:infinitePayBody}),async(req,res)=>
  res.json(await settings.saveInfinitePay(self(req),req.valid.body,actorOf(req))));
partnerMasterPixRouter.put('/gateways/manual_pix',profileSensitiveLimiter,validate({body:manualPixBody}),async(req,res)=>
  res.json(await settings.saveManualPix(self(req),req.valid.body,actorOf(req))));
partnerMasterPixRouter.patch('/gateways/:provider',stockWriteLimiter,validate({params:providerParam,body:z.object({active:z.boolean()}).strict()}),async(req,res)=>{
  const {provider}=req.valid.params,{active}=req.valid.body;
  res.json(provider==='mercadopago'?await svc.setActive(self(req),active,actorOf(req)):await settings.setGatewayActive(self(req),provider,active,actorOf(req)));
});
// ---- Comprador ----
partnerMasterPixRouter.post('/orders/:id/confirm-return',pixCreateLimiter,validate({params,body:returnBody}),async(req,res)=>{
  await gateways.confirmInfinitePayReturn(self(req),req.valid.params.id,req.valid.body);
  res.json(await svc.orderForBuyer(self(req),req.valid.params.id,{refresh:false}));
});
partnerMasterPixRouter.post('/orders/:id/claim-paid',stockWriteLimiter,validate({params}),async(req,res)=>{
  await gateways.claimPaid(self(req),req.valid.params.id,actorOf(req));
  res.json(await svc.orderForBuyer(self(req),req.valid.params.id,{refresh:false}));
});
partnerMasterPixRouter.post('/orders/:id/cancel',stockWriteLimiter,validate({params}),async(req,res)=>{
  await gateways.cancelByBuyer(self(req),req.valid.params.id,actorOf(req));
  res.json(await svc.orderForBuyer(self(req),req.valid.params.id,{refresh:false}));
});
// ---- Vendedor: confirma ou recusa recebimento no Pix com chave própria ----
partnerMasterPixRouter.post('/sales/:id/confirm',stockWriteLimiter,validate({params}),async(req,res)=>
  res.json(svc.publicOrder(await gateways.sellerConfirm(self(req),req.valid.params.id,actorOf(req)))));
partnerMasterPixRouter.post('/sales/:id/reject',stockWriteLimiter,validate({params}),async(req,res)=>
  res.json(svc.publicOrder(await gateways.sellerReject(self(req),req.valid.params.id,actorOf(req)))));

export const adminMasterPixRouter=Router();
adminMasterPixRouter.use(noStore);
const isSuper=req=>{if(req.user.role!=='superadmin')throw new AppError(403,'FORBIDDEN','Operação exclusiva do Superadmin.');};
adminMasterPixRouter.get('/orders',requirePermission('billing:read'),async(req,res)=>{
  isSuper(req);
  const sellerId=req.query.sellerId?String(req.query.sellerId):null;
  if(sellerId && !uuid.safeParse(sellerId).success)throw new AppError(422,'INVALID_ACCOUNT','Revenda inválida.');
  res.json({data:await svc.adminOrders({status:String(req.query.status||''),sellerId,limit:100})});
});
adminMasterPixRouter.post('/orders/:id/recheck',requirePermission('billing:write'),stockWriteLimiter,validate({params}),async(req,res)=>{
  isSuper(req);const order=await svc.reconcileOrder(req.valid.params.id,{force:true});
  res.json(svc.publicOrder(order));
});
adminMasterPixRouter.get('/accounts/:id/settings',requirePermission('partners:read'),validate({params}),async(req,res)=>{
  isSuper(req);res.json(await svc.mySettings(req.valid.params.id,{admin:true}));
});
adminMasterPixRouter.put('/accounts/:id/settings',requirePermission('partners:write'),profileSensitiveLimiter,
  validate({params,body:accountBody}),async(req,res)=>{
    isSuper(req);res.json(await svc.saveSettings(req.valid.params.id,req.valid.body,actorOf(req),{admin:true}));
  });
adminMasterPixRouter.get('/accounts/:id/gateways',requirePermission('partners:read'),validate({params}),async(req,res)=>{
  isSuper(req);res.json({data:await settings.listGateways(req.valid.params.id,{admin:true})});
});
adminMasterPixRouter.put('/accounts/:id/gateways/infinitepay',requirePermission('partners:write'),profileSensitiveLimiter,
  validate({params,body:infinitePayBody}),async(req,res)=>{
    isSuper(req);res.json(await settings.saveInfinitePay(req.valid.params.id,req.valid.body,actorOf(req),{admin:true}));
  });
adminMasterPixRouter.put('/accounts/:id/gateways/manual_pix',requirePermission('partners:write'),profileSensitiveLimiter,
  validate({params,body:manualPixBody}),async(req,res)=>{
    isSuper(req);res.json(await settings.saveManualPix(req.valid.params.id,req.valid.body,actorOf(req),{admin:true}));
  });
adminMasterPixRouter.get('/accounts/:id/prices',requirePermission('partners:read'),validate({params}),async(req,res)=>{
  isSuper(req);res.json({data:await svc.listOwnPrices(req.valid.params.id,{admin:true})});
});
adminMasterPixRouter.put('/accounts/:id/prices',requirePermission('partners:write'),stockWriteLimiter,
  validate({params,body:price}),async(req,res)=>{
    isSuper(req);res.json(await svc.savePrice(req.valid.params.id,req.valid.body,actorOf(req),{admin:true}));
  });

export const webhookMasterPixRouter=Router();
// InfinitePay não assina o webhook: o aviso só dispara uma consulta ao /payment_check, que é a prova do pagamento.
webhookMasterPixRouter.post('/infinitepay/:id',webhookLimiter,validate({params}),async(req,res)=>
  res.status(200).json({ok:true,...await gateways.handleInfinitePayWebhook(req.valid.params.id,req.body)}));
webhookMasterPixRouter.post('/mercadopago/:id',webhookLimiter,validate({params}),async(req,res)=>
  res.status(200).json({ok:true,...await svc.handleWebhook(req.valid.params.id,req)}));
