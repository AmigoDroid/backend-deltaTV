import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { actorOf } from '../../shared/audit.js';
import { requirePermission } from '../../middleware/authenticate.js';
import { pixCreateLimiter, pixReadLimiter, stockWriteLimiter, webhookLimiter, profileSensitiveLimiter } from '../../middleware/security.js';
import { AppError } from '../../shared/errors.js';
import * as svc from './master-pix.service.js';

const uuid=z.string().uuid();
const params=z.object({id:uuid});
const price=z.object({months:z.number().int().min(1).max(120),unitPriceCents:z.number().int().positive().safe(),active:z.boolean().default(true)}).strict();
const accountBody=z.object({
  accessToken:z.string().trim().min(30).max(4096),
  webhookSecret:z.string().trim().min(16).max(512),
  currentPassword:z.string().min(8).max(128),
  active:z.boolean().default(true),
}).strict();
const orderBody=z.object({months:z.number().int().min(1).max(120),quantity:z.number().int().min(1).max(2_147_483_647),
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
adminMasterPixRouter.get('/accounts/:id/prices',requirePermission('partners:read'),validate({params}),async(req,res)=>{
  isSuper(req);res.json({data:await svc.listOwnPrices(req.valid.params.id,{admin:true})});
});
adminMasterPixRouter.put('/accounts/:id/prices',requirePermission('partners:write'),stockWriteLimiter,
  validate({params,body:price}),async(req,res)=>{
    isSuper(req);res.json(await svc.savePrice(req.valid.params.id,req.valid.body,actorOf(req),{admin:true}));
  });

export const webhookMasterPixRouter=Router();
webhookMasterPixRouter.post('/mercadopago/:id',webhookLimiter,validate({params}),async(req,res)=>
  res.status(200).json({ok:true,...await svc.handleWebhook(req.valid.params.id,req)}));
