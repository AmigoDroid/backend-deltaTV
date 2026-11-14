import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/validate.js';
import { actorOf } from '../../shared/audit.js';
import { AppError } from '../../shared/errors.js';
import { requirePermission } from '../../middleware/authenticate.js';
import { clientWriteLimiter, macWriteLimiter, macLookupLimiter } from '../../middleware/security.js';
import { loadReseller, assertReseller } from '../devices/reseller-devices.service.js';
import * as commerce from './commerce.service.js';
import * as commissions from './commission.service.js';

const uuid=z.string().uuid();
const id=z.object({id:uuid});
const field=z.string().trim();
const customer=z.object({name:field.min(2).max(160),email:z.string().trim().email().max(200).nullable().optional(),
  phone:field.max(40).nullable().optional(),notes:field.max(500).nullable().optional()}).strict();
const plan=z.object({name:field.min(2).max(120),priceCents:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  periodMonths:z.number().int().min(1).max(120).default(1),billingMode:z.enum(['prepaid','postpaid','hybrid']).default('prepaid'),
  includedSlots:z.number().int().nonnegative().max(2147483647).nullable().default(1),
  allowExtra:z.boolean().default(false),allowResell:z.boolean().default(false),
  overageCents:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  graceDays:z.number().int().min(0).max(365).default(5)}).strict();
const customerPlan=plan.omit({allowResell:true}).extend({allowResell:z.literal(false).default(false)});
const paging=z.object({q:z.string().trim().max(100).default(''),page:z.coerce.number().int().min(1).default(1),
  pageSize:z.coerce.number().int().min(1).max(100).default(30)});
const mac=z.object({mac:z.string().trim().min(12).max(40)});
const state=z.object({state:z.enum(['active','past_due','restricted','suspended','cancelled']),reason:field.min(3).max(400)}).strict();

export const partnerCommerce=Router();
partnerCommerce.use(async(req,_res,next)=>{assertReseller(await loadReseller(req.user.partnerId));next();});
const partnerId=req=>req.user.partnerId;
partnerCommerce.get('/customers',validate({query:paging}),async(req,res)=>res.set('Cache-Control','no-store')
  .json(await commerce.listCustomers(partnerId(req),req.valid.query)));
partnerCommerce.post('/customers',clientWriteLimiter,validate({body:customer}),async(req,res)=>res.status(201)
  .json(await commerce.createCustomer(partnerId(req),req.valid.body,actorOf(req))));
partnerCommerce.get('/customers/:id',validate({params:id}),async(req,res)=>res.set('Cache-Control','no-store')
  .json(await commerce.getCustomer(partnerId(req),req.valid.params.id)));
partnerCommerce.patch('/customers/:id',clientWriteLimiter,validate({params:id,body:customer.partial().refine(x=>Object.keys(x).length>0)}),async(req,res)=>
  res.json(await commerce.updateCustomer(partnerId(req),req.valid.params.id,req.valid.body,actorOf(req))));
partnerCommerce.get('/plans',async(req,res)=>res.set('Cache-Control','no-store').json({data:await commerce.listPlans({partnerId:partnerId(req),kind:'customer'})}));
partnerCommerce.post('/plans',clientWriteLimiter,validate({body:customerPlan}),async(req,res)=>res.status(201)
  .json(await commerce.createPlan({partnerId:partnerId(req),kind:'customer',input:req.valid.body,actor:actorOf(req)})));
partnerCommerce.post('/customers/:id/subscriptions',clientWriteLimiter,
  validate({params:id,body:z.object({planId:uuid}).strict()}),async(req,res)=>res.status(201)
    .json(await commerce.createCustomerSubscription(partnerId(req),req.valid.params.id,req.valid.body.planId,actorOf(req))));
partnerCommerce.get('/subscriptions/:id/slots',validate({params:id}),async(req,res)=>
  res.set('Cache-Control','no-store').json({data:await commerce.listSlots(partnerId(req),req.valid.params.id)}));
partnerCommerce.post('/subscriptions/:id/slots',macWriteLimiter,validate({params:id,body:mac}),async(req,res)=>res.status(201)
  .json(await commerce.linkExistingActivation(partnerId(req),req.valid.params.id,req.valid.body.mac,actorOf(req))));
partnerCommerce.post('/subscriptions/:id/slots/release',macWriteLimiter,validate({params:id,body:mac}),async(req,res)=>
  res.json(await commerce.releaseSlot(partnerId(req),req.valid.params.id,req.valid.body.mac,actorOf(req))));
partnerCommerce.post('/subscriptions/:id/state',clientWriteLimiter,validate({params:id,body:state}),async(req,res)=>
  res.json(await commerce.changeSubscriptionState(partnerId(req),req.valid.params.id,req.valid.body.state,req.valid.body.reason,actorOf(req))));
partnerCommerce.get('/master-contract',async(req,res)=>res.set('Cache-Control','no-store').json({data:await commerce.masterContract(partnerId(req))}));
partnerCommerce.get('/commissions',async(req,res)=>res.set('Cache-Control','no-store').json({data:await commissions.listBeneficiaryCommissions(partnerId(req))}));
partnerCommerce.put('/commissions/children/:id',clientWriteLimiter,validate({params:id,body:z.object({basisPoints:z.number().int().min(0).max(10000)}).strict()}),async(req,res)=>
  res.json(await commissions.setRule(req.valid.params.id,partnerId(req),req.valid.body.basisPoints,actorOf(req))));

export const adminCommerce=Router();
adminCommerce.get('/customers/:partnerId',requirePermission('clients:read'),validate({params:z.object({partnerId:uuid}),query:paging}),async(req,res)=>
  res.set('Cache-Control','no-store').json(await commerce.listCustomers(req.valid.params.partnerId,req.valid.query)));
adminCommerce.get('/customers/:partnerId/:id',requirePermission('clients:read'),validate({params:z.object({partnerId:uuid,id:uuid})}),async(req,res)=>
  res.set('Cache-Control','no-store').json(await commerce.getCustomer(req.valid.params.partnerId,req.valid.params.id)));
adminCommerce.post('/customers/:partnerId',requirePermission('clients:write'),clientWriteLimiter,validate({params:z.object({partnerId:uuid}),body:customer}),async(req,res)=>
  res.status(201).json(await commerce.createCustomer(req.valid.params.partnerId,req.valid.body,actorOf(req))));
const superadmin=(req,_res,next)=>req.user.role==='superadmin'?next():next(new AppError(403,'FORBIDDEN','Somente o Superadmin gerencia contratos SaaS e políticas globais.'));
adminCommerce.get('/master-plans',superadmin,async(req,res)=>res.json({data:await commerce.listPlans({kind:'master'})}));
adminCommerce.post('/master-plans',superadmin,clientWriteLimiter,validate({body:plan}),async(req,res)=>res.status(201)
  .json(await commerce.createPlan({kind:'master',input:req.valid.body,actor:actorOf(req)})));
adminCommerce.get('/master-contracts/:partnerId',superadmin,validate({params:z.object({partnerId:uuid})}),async(req,res)=>
  res.json({data:await commerce.masterContract(req.valid.params.partnerId)}));
adminCommerce.post('/master-contracts/:partnerId',superadmin,clientWriteLimiter,
  validate({params:z.object({partnerId:uuid}),body:z.object({planId:uuid}).strict()}),async(req,res)=>res.status(201)
    .json(await commerce.createMasterSubscription(req.valid.params.partnerId,req.valid.body.planId,actorOf(req))));
adminCommerce.post('/subscriptions/:partnerId/:id/state',superadmin,clientWriteLimiter,
  validate({params:z.object({partnerId:uuid,id:uuid}),body:state}),async(req,res)=>
    res.json(await commerce.changeSubscriptionState(req.valid.params.partnerId,req.valid.params.id,req.valid.body.state,req.valid.body.reason,actorOf(req),{admin:true})));
adminCommerce.get('/commission-policy',superadmin,async(req,res)=>res.json(await commissions.currentConfig()));
adminCommerce.put('/commission-policy',superadmin,clientWriteLimiter,
  validate({body:z.object({maxTotalBps:z.number().int().min(0).max(10000)}).strict()}),async(req,res)=>
    res.json(await commissions.setGlobalCap(req.valid.body.maxTotalBps,actorOf(req))));
adminCommerce.put('/commission-rules/:sellerId/:beneficiaryId',superadmin,clientWriteLimiter,
  validate({params:z.object({sellerId:uuid,beneficiaryId:uuid}),body:z.object({basisPoints:z.number().int().min(0).max(10000)}).strict()}),async(req,res)=>
    res.json(await commissions.setRule(req.valid.params.sellerId,req.valid.params.beneficiaryId,req.valid.body.basisPoints,actorOf(req),{admin:true})));
adminCommerce.get('/commission-rules/:sellerId',superadmin,validate({params:z.object({sellerId:uuid})}),async(req,res)=>
  res.json({data:await commissions.listRules(req.valid.params.sellerId)}));
// Operações sobre registros comerciais das revendas por Superadmin; o alvo é explícito, sempre auditado.
adminCommerce.patch('/customers/:partnerId/:id',requirePermission('clients:write'),clientWriteLimiter,
  validate({params:z.object({partnerId:uuid,id:uuid}),body:customer.partial().refine(x=>Object.keys(x).length>0)}),async(req,res)=>
  res.json(await commerce.updateCustomer(req.valid.params.partnerId,req.valid.params.id,req.valid.body,actorOf(req))));
adminCommerce.get('/plans/:partnerId',requirePermission('clients:read'),validate({params:z.object({partnerId:uuid})}),async(req,res)=>
  res.json({data:await commerce.listPlans({partnerId:req.valid.params.partnerId,kind:'customer'})}));
adminCommerce.post('/plans/:partnerId',requirePermission('clients:write'),clientWriteLimiter,
  validate({params:z.object({partnerId:uuid}),body:customerPlan}),async(req,res)=>res.status(201)
  .json(await commerce.createPlan({partnerId:req.valid.params.partnerId,kind:'customer',input:req.valid.body,actor:actorOf(req)})));
adminCommerce.post('/customers/:partnerId/:id/subscriptions',requirePermission('clients:write'),clientWriteLimiter,
  validate({params:z.object({partnerId:uuid,id:uuid}),body:z.object({planId:uuid}).strict()}),async(req,res)=>res.status(201)
  .json(await commerce.createCustomerSubscription(req.valid.params.partnerId,req.valid.params.id,req.valid.body.planId,actorOf(req))));
adminCommerce.get('/subscriptions/:partnerId/:id/slots',requirePermission('clients:read'),
  validate({params:z.object({partnerId:uuid,id:uuid})}),async(req,res)=>
  res.json({data:await commerce.listSlots(req.valid.params.partnerId,req.valid.params.id)}));
adminCommerce.post('/subscriptions/:partnerId/:id/slots',requirePermission('clients:write'),macWriteLimiter,
  validate({params:z.object({partnerId:uuid,id:uuid}),body:mac}),async(req,res)=>res.status(201)
  .json(await commerce.linkExistingActivation(req.valid.params.partnerId,req.valid.params.id,req.valid.body.mac,actorOf(req))));
adminCommerce.post('/subscriptions/:partnerId/:id/slots/release',requirePermission('clients:write'),macWriteLimiter,
  validate({params:z.object({partnerId:uuid,id:uuid}),body:mac}),async(req,res)=>
  res.json(await commerce.releaseSlot(req.valid.params.partnerId,req.valid.params.id,req.valid.body.mac,actorOf(req))));
